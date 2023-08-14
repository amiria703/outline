import Logger from "@server/logging/Logger";
import { setResource } from "@server/logging/tracer";
import { traceFunction } from "@server/logging/tracing";
import { initI18n } from "@server/utils/i18n";
import {
  globalEventQueue,
  processorEventQueue,
  websocketQueue,
  taskQueue,
} from "../queues";
import processors from "../queues/processors";
import tasks from "../queues/tasks";

export default function init() {
  void initI18n();

  // This queue processes the global event bus
  globalEventQueue
    .process(
      traceFunction({
        serviceName: "worker",
        spanName: "process",
        isRoot: true,
      })(async function (job) {
        const event = job.data;
        let err;

        setResource(`Event.${event.name}`);

        Logger.info("worker", `Processing ${event.name}`, {
          event,
          attempt: job.attemptsMade,
        });

        // For each registered processor we check to see if it wants to handle the
        // event (applicableEvents), and if so add a new queued job specifically
        // for that processor.
        for (const name in processors) {
          const ProcessorClass = processors[name];

          if (!ProcessorClass) {
            throw new Error(
              `Received event "${event.name}" for processor (${name}) that isn't registered. Check the file name matches the class name.`
            );
          }

          try {
            if (name === "WebsocketsProcessor") {
              // websockets are a special case on their own queue because they must
              // only be consumed by the websockets service rather than workers.
              await websocketQueue.add(job.data);
            } else if (
              ProcessorClass.applicableEvents.includes(event.name) ||
              ProcessorClass.applicableEvents.includes("*")
            ) {
              await processorEventQueue.add({ event, name });
            }
          } catch (error) {
            Logger.error(
              `Error adding ${event.name} to ${name} queue`,
              error,
              event
            );
            err = error;
          }
        }

        if (err) {
          throw err;
        }
      })
    )
    .catch((err) => {
      Logger.fatal("Error starting globalEventQueue", err);
    });

  // Jobs for individual processors are processed here. Only applicable events
  // as unapplicable events were filtered in the global event queue above.
  processorEventQueue
    .process(
      traceFunction({
        serviceName: "worker",
        spanName: "process",
        isRoot: true,
      })(async function (job) {
        const { event, name } = job.data;
        const ProcessorClass = processors[name];

        setResource(`Processor.${name}`);

        if (!ProcessorClass) {
          throw new Error(
            `Received event "${event.name}" for processor (${name}) that isn't registered. Check the file name matches the class name.`
          );
        }

        const processor = new ProcessorClass();

        if (processor.perform) {
          Logger.info("worker", `${name} running ${event.name}`, {
            event,
          });

          try {
            await processor.perform(event);
          } catch (err) {
            Logger.error(
              `Error processing ${event.name} in ${name}`,
              err,
              event
            );
            throw err;
          }
        }
      })
    )
    .catch((err) => {
      Logger.fatal("Error starting processorEventQueue", err);
    });

  // Jobs for async tasks are processed here.
  taskQueue
    .process(
      traceFunction({
        serviceName: "worker",
        spanName: "process",
        isRoot: true,
      })(async function (job) {
        const { name, props } = job.data;
        const TaskClass = tasks[name];

        setResource(`Task.${name}`);

        if (!TaskClass) {
          throw new Error(
            `Task "${name}" is not registered. Check the file name matches the class name.`
          );
        }

        Logger.info("worker", `${name} running`, props);

        const task = new TaskClass();

        try {
          await task.perform(props);
        } catch (err) {
          Logger.error(`Error processing task in ${name}`, err, props);
          throw err;
        }
      })
    )
    .catch((err) => {
      Logger.fatal("Error starting taskQueue", err);
    });
}

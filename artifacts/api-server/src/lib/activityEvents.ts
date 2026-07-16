import { EventEmitter } from "events";

// In-process pub/sub used to push "rostering activity happened" notifications
// to connected SSE clients the moment any activity row is inserted.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const ACTIVITY_EVENT = "activity";

export function emitRosteringActivity(): void {
  emitter.emit(ACTIVITY_EVENT);
}

export function onRosteringActivity(listener: () => void): () => void {
  emitter.on(ACTIVITY_EVENT, listener);
  return () => emitter.off(ACTIVITY_EVENT, listener);
}

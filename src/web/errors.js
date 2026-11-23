// Keep independent failure sources; clearing one cannot erase another.
export class ErrorState {
  constructor() { this.messages = new Map(); }
  set(message, source = "action") {
    if (message) this.messages.set(source, message);
    else this.messages.delete(source);
    return this.text();
  }
  clear() { this.messages.clear(); }
  text() { return [...this.messages.values()].join(" · "); }
}

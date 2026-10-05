function suppressSqliteWarning(): void {
  if (typeof process === "undefined" || typeof process.listeners !== "function") return;
  const defaultListeners = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && warning.message?.includes("SQLite")) return;
    for (const listener of defaultListeners) {
      listener.call(process, warning);
    }
  });
}

suppressSqliteWarning();

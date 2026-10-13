const realEnv = process.env;

if (realEnv.STAGEFLOW_HOME?.trim() && !realEnv.STAGEFLOW_CREDENTIAL_HOME?.trim()) {
  realEnv.STAGEFLOW_CREDENTIAL_HOME = realEnv.STAGEFLOW_HOME;
}

process.env = new Proxy(realEnv, {
  set(target, prop, value) {
    const key = typeof prop === "string" ? prop : undefined;
    const next = typeof value === "string" ? value : String(value);
    if (key === "STAGEFLOW_HOME") {
      const prev = target.STAGEFLOW_HOME;
      target.STAGEFLOW_HOME = next;
      // globalStageflowHome writes the resolved path back. The same path must
      // not replace an explicit credential directory.
      if (prev !== next) {
        target.STAGEFLOW_CREDENTIAL_HOME = next;
      }
      return true;
    }
    if (key === undefined) return false;
    target[key] = next;
    return true;
  },
  deleteProperty(target, prop) {
    const key = typeof prop === "string" ? prop : undefined;
    if (key === undefined) return false;
    if (key === "STAGEFLOW_HOME") {
      delete target.STAGEFLOW_HOME;
      delete target.STAGEFLOW_CREDENTIAL_HOME;
      return true;
    }
    delete target[key];
    return true;
  },
});

// Retry a headless Claude CLI call once only when its model id was rejected.

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function isModelRejection(spawnResult, model) {
  if (typeof model !== "string" || !model.trim()) return false;
  if (!spawnResult || spawnResult.status === 0 || spawnResult.error) return false;
  const output = String(spawnResult.stdout || "") + "\n" + String(spawnResult.stderr || "");
  if (!output.trim()) return false;

  // Require the exact attempted model id as well as model-specific rejection wording.
  // This avoids spending a second run on a failure that names a different model.
  const modelPattern = new RegExp(`(?:^|[^a-z0-9._-])${escapeRegExp(model)}(?=$|[^a-z0-9._-])`, "i");
  const hasModelId = modelPattern.test(output);
  const hasRejection = /unknown model|invalid model|model not found|model_not_found|does not support|not available/i.test(output);
  return hasModelId && hasRejection;
}

export function spawnWithModelFallback(spawnOnce, { model, fallbackModel, log = console.error }) {
  const result = spawnOnce(model);
  if (!isModelRejection(result, model) || !fallbackModel || fallbackModel === model) {
    return { result, modelUsed: model, retried: false };
  }

  const reason = (String(result.stderr || "") || String(result.stdout || "")).trim().slice(0, 300);
  log(`model ${model} was rejected (${reason}); retrying once with ${fallbackModel}`);
  return { result: spawnOnce(fallbackModel), modelUsed: fallbackModel, retried: true };
}

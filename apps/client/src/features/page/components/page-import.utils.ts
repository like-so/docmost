export function getImportOutcome(importedCount: number, failedCount: number) {
  if (importedCount === 0) return "failed";
  return failedCount === 0 ? "complete" : "partial";
}

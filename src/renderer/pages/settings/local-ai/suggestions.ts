// Official Ollama library tags checked against https://ollama.com/library/qwen3.5
// and https://ollama.com/library/gemma4 (2026-11-08). Total RAM bands are
// deliberately more conservative than download sizes; runtime use varies.
export const suggestions = [
  { tag: 'qwen3.5:0.8b', family: 'Qwen 3.5', ramGb: 8, weight: 'Light' },
  { tag: 'qwen3.5:4b', family: 'Qwen 3.5', ramGb: 16, weight: 'Medium' },
  { tag: 'gemma4:e2b', family: 'Gemma 4', ramGb: 16, weight: 'Medium' },
  { tag: 'gemma4:e4b', family: 'Gemma 4', ramGb: 24, weight: 'Heavy' },
] as const;

export function suggestionFit(
  totalBytes: number | null | undefined,
  ramGb: number,
) {
  if (!totalBytes) return 'Memory unknown';
  return totalBytes / 1024 ** 3 >= ramGb ? 'Might fit' : 'Likely too heavy';
}

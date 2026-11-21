import type {
  HardwareProfile,
  ModelDescriptor,
  ModelRecommendation,
  ModelRecommendations,
} from '../../../shared/contracts';

/**
 * Headroom factor applied to a model's on-disk size to approximate the working
 * memory it needs. Deliberately conservative; this is a "may fit" heuristic,
 * never a statement about task quality.
 */
const MEMORY_HEADROOM = 1.3;

/** A model comfortably within this share of total RAM is treated as likely. */
const LIKELY_MEMORY_SHARE = 0.6;

const QUALITY_WARNING =
  'Fit is based on memory only; task quality and tool use are not ' +
  'benchmarked.';

/** Sort key that places models of unknown size last. */
const UNKNOWN_SIZE_SORT_KEY = Number.MAX_SAFE_INTEGER;

/**
 * Pure recommendation policy. Accepts a hardware snapshot and the installed
 * model descriptors and returns ranked, qualified candidates. Only installed,
 * local models are ever recommended: cloud or unknown-locality models fail
 * closed and are excluded from local-only recommendations. No model is
 * downloaded, and no exact download suggestion is invented.
 */
export function recommendOllamaModels(
  hardware: HardwareProfile,
  models: ModelDescriptor[],
): ModelRecommendations {
  const localCandidates = models.filter(
    (model) => model.installed && model.locality === 'local',
  );

  const notes: string[] = [];
  const excludedNonLocal = models.length - localCandidates.length;
  if (excludedNonLocal > 0) {
    notes.push(
      'Cloud or unknown-locality models were excluded from local-only ' +
        'recommendations.',
    );
  }

  if (localCandidates.length === 0) {
    notes.push(
      models.length === 0
        ? 'No local Ollama models are installed. Install a model with ' +
            'Ollama before requesting recommendations.'
        : 'No installed local models are available to recommend.',
    );

    return { items: [], notes };
  }

  const totalMemory = hardware.totalMemoryBytes;
  const scored = localCandidates.map((model) => scoreModel(model, totalMemory));

  // Rank: likely before uncertain, then smaller models first (safer fit).
  scored.sort((a, b) => {
    if (a.recommendation.fit !== b.recommendation.fit) {
      return a.recommendation.fit === 'likely' ? -1 : 1;
    }

    return a.sizeForSort - b.sizeForSort;
  });

  if (totalMemory <= 0) {
    notes.push('Total system memory is unknown; fit estimates are uncertain.');
  }

  return { items: scored.map((entry) => entry.recommendation), notes };
}

function scoreModel(
  model: ModelDescriptor,
  totalMemory: number,
): { recommendation: ModelRecommendation; sizeForSort: number } {
  const reasons: string[] = [];
  const warnings: string[] = [QUALITY_WARNING];

  if (model.parameterSize) {
    reasons.push(`Reported parameter size ${model.parameterSize}.`);
  }

  if (model.quantization) {
    reasons.push(`Quantisation ${model.quantization}.`);
  }

  const size = model.sizeBytes ?? null;
  if (size === null) {
    warnings.push('Model size is unknown; cannot estimate memory fit.');
    return {
      recommendation: {
        modelId: model.id,
        fit: 'uncertain',
        reasons,
        warnings,
      },
      sizeForSort: UNKNOWN_SIZE_SORT_KEY,
    };
  }

  if (totalMemory <= 0) {
    warnings.push('System memory is unknown; cannot confirm this model fits.');
    return {
      recommendation: {
        modelId: model.id,
        fit: 'uncertain',
        reasons,
        warnings,
      },
      sizeForSort: size,
    };
  }

  let fit: ModelRecommendation['fit'];
  const required = size * MEMORY_HEADROOM;
  const share = required / totalMemory;
  if (share <= LIKELY_MEMORY_SHARE) {
    fit = 'likely';
    reasons.push(
      'Estimated memory need is comfortably within total system memory.',
    );
  } else if (required <= totalMemory) {
    fit = 'uncertain';
    warnings.push(
      'Estimated memory need uses most of the system memory; performance ' +
        'may suffer.',
    );
  } else {
    fit = 'uncertain';
    warnings.push(
      'Estimated memory need exceeds total system memory; the model may ' +
        'not run.',
    );
  }

  return {
    recommendation: { modelId: model.id, fit, reasons, warnings },
    sizeForSort: size,
  };
}

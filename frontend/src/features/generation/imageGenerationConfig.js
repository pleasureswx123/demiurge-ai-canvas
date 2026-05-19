export const ratioOptions = [
  { id: '自适应', label: '自适应', iconClass: 'h-[12px] w-[16px]' },
  { id: '1:1', label: '1:1', iconClass: 'h-[14px] w-[14px]' },
  { id: '9:16', label: '9:16', iconClass: 'h-[18px] w-[10px]' },
  { id: '16:9', label: '16:9', iconClass: 'h-[10px] w-[18px]' },
  { id: '3:4', label: '3:4', iconClass: 'h-[16px] w-[12px]' },
  { id: '4:3', label: '4:3', iconClass: 'h-[12px] w-[16px]' },
  { id: '3:2', label: '3:2', iconClass: 'h-[12px] w-[18px]' },
  { id: '2:3', label: '2:3', iconClass: 'h-[18px] w-[12px]' },
  { id: '4:5', label: '4:5', iconClass: 'h-[16px] w-[13px]' },
  { id: '5:4', label: '5:4', iconClass: 'h-[13px] w-[16px]' },
  { id: '21:9', label: '21:9', iconClass: 'h-[8px] w-[24px]' },
];

const allRatios = ratioOptions.map((item) => item.id);

const baseSizeMap2K = {
  '自适应': { width: 2048, height: 2048 },
  '1:1': { width: 2048, height: 2048 },
  '9:16': { width: 1440, height: 2560 },
  '16:9': { width: 2560, height: 1440 },
  '3:4': { width: 1728, height: 2304 },
  '4:3': { width: 2304, height: 1728 },
  '3:2': { width: 2496, height: 1664 },
  '2:3': { width: 1664, height: 2496 },
  '4:5': { width: 1792, height: 2240 },
  '5:4': { width: 2240, height: 1792 },
  '21:9': { width: 3024, height: 1296 },
};

const sizeScaleMap = {
  '1K': 0.5,
  '2K': 1,
  '4K': 2,
};

const seedreamMinPixelArea = 3686400;

function roundToStep(value, step = 64) {
  return Math.max(step, Math.round(value / step) * step);
}

function floorToStep(value, step = 64) {
  return Math.max(step, Math.floor(value / step) * step);
}

function mapScaledSize(ratio, size) {
  const base = baseSizeMap2K[ratio] || baseSizeMap2K['1:1'];
  const scale = sizeScaleMap[size] || 1;
  return {
    width: roundToStep(base.width * scale),
    height: roundToStep(base.height * scale),
  };
}

function mapSeedreamSize(ratio, size) {
  let { width, height } = mapScaledSize(ratio, size);
  const area = width * height;
  if (area < seedreamMinPixelArea) {
    const scale = Math.sqrt(seedreamMinPixelArea / area);
    width = roundToStep(width * scale);
    height = roundToStep(height * scale);
  }

  const maxSide = Math.max(width, height);
  if (maxSide > 4096) {
    const scale = 4096 / maxSide;
    width = roundToStep(width * scale);
    height = roundToStep(height * scale);
  }

  while (width * height < seedreamMinPixelArea) {
    if (width <= height && width < 4096) {
      width += 64;
    } else if (height < 4096) {
      height += 64;
    } else {
      break;
    }
  }

  return `${width}x${height}`;
}

function mapScaledSizeText(ratio, size) {
  const { width, height } = mapScaledSize(ratio, size);
  return `${width}x${height}`;
}

/** gpt-image-2 (OpenAI Images API): flexible size with hard caps — see image-generation guide */
const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;

/**
 * Maps UI tiers 1K / 2K / 4K to WxH that respect gpt-image-2 limits:
 * max edge ≤3840px, total pixels ≤8,294,400, edges multiple of 16 (we use step 64 like other models).
 * Doc "popular" examples include 2048² / 2048×1152 (2K) and 3840×2160 (4K landscape).
 */
function mapGptImage2Size(ratio, size) {
  let width;
  let height;
  ({ width, height } = mapScaledSize(ratio, size));

  for (let iter = 0; iter < 16; iter++) {
    let w = width;
    let h = height;
    let changed = false;
    let area = w * h;
    let maxEdge = Math.max(w, h);

    if (area < GPT_IMAGE_2_MIN_PIXELS) {
      const s = Math.sqrt(GPT_IMAGE_2_MIN_PIXELS / area);
      w = roundToStep(w * s);
      h = roundToStep(h * s);
      changed = true;
    }

    maxEdge = Math.max(w, h);
    area = w * h;
    if (maxEdge > GPT_IMAGE_2_MAX_EDGE) {
      const s = GPT_IMAGE_2_MAX_EDGE / maxEdge;
      w = roundToStep(w * s);
      h = roundToStep(h * s);
      changed = true;
    }

    area = w * h;
    if (area > GPT_IMAGE_2_MAX_PIXELS) {
      const s = Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / area);
      w = roundToStep(w * s);
      h = roundToStep(h * s);
      changed = true;
    }

    width = w;
    height = h;
    if (!changed) break;
  }

  const longE = Math.max(width, height);
  const shortE = Math.min(width, height);
  if (shortE > 0 && longE / shortE > 3) {
    const targetLong = roundToStep(shortE * 3);
    const s = targetLong / longE;
    width = roundToStep(width * s);
    height = roundToStep(height * s);
    for (let iter = 0; iter < 8; iter++) {
      let w = width;
      let h = height;
      let changed = false;
      let maxEdge = Math.max(w, h);
      let area = w * h;
      if (maxEdge > GPT_IMAGE_2_MAX_EDGE) {
        const sc = GPT_IMAGE_2_MAX_EDGE / maxEdge;
        w = roundToStep(w * sc);
        h = roundToStep(h * sc);
        changed = true;
      }
      area = w * h;
      if (area > GPT_IMAGE_2_MAX_PIXELS) {
        const sc = Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / area);
        w = roundToStep(w * sc);
        h = roundToStep(h * sc);
        changed = true;
      }
      width = w;
      height = h;
      if (!changed) break;
    }
  }

  // roundToStep(64) can push total pixels slightly over the API cap — shrink with floor until within bounds
  for (let iter = 0; iter < 24; iter++) {
    const area = width * height;
    const maxEdge = Math.max(width, height);
    if (
      area <= GPT_IMAGE_2_MAX_PIXELS &&
      maxEdge <= GPT_IMAGE_2_MAX_EDGE &&
      area >= GPT_IMAGE_2_MIN_PIXELS
    ) {
      break;
    }
    let s = 1;
    if (maxEdge > GPT_IMAGE_2_MAX_EDGE) {
      s = Math.min(s, GPT_IMAGE_2_MAX_EDGE / maxEdge);
    }
    if (area > GPT_IMAGE_2_MAX_PIXELS) {
      s = Math.min(s, Math.sqrt(GPT_IMAGE_2_MAX_PIXELS / area));
    }
    if (area < GPT_IMAGE_2_MIN_PIXELS) {
      s = Math.max(s, Math.sqrt(GPT_IMAGE_2_MIN_PIXELS / area));
      width = roundToStep(width * s);
      height = roundToStep(height * s);
    } else {
      width = floorToStep(width * s);
      height = floorToStep(height * s);
    }
  }

  return `${width}x${height}`;
}

export const imageModelMap = {
  'Seedream-5.0': {
    label: 'Seedream-5.0',
    backend: 'volcengine_ark',
    apiModel: 'doubao-seedream-5-0-260128',
    endpoint: '/api/v3/images/generations',
    ratios: allRatios,
    sizes: ['1K', '2K', '4K'],
    defaultRatio: '16:9',
    defaultSize: '1K',
    mapSize: mapSeedreamSize,
  },
  'Nano Banana 2': {
    label: 'Nano Banana 2',
    backend: 'vectorengine_openai',
    apiModel: 'gemini-3.1-flash-image-preview',
    endpoint: '/v1/chat/completions',
    ratios: allRatios,
    sizes: ['1K', '2K', '4K'],
    defaultRatio: '16:9',
    defaultSize: '1K',
    mapSize: mapScaledSizeText,
  },
  'gemini-3-pro-image-preview': {
    label: 'Nano banana pro',
    backend: 'vectorengine_openai',
    apiModel: 'gemini-3-pro-image-preview',
    endpoint: '/v1/chat/completions',
    ratios: allRatios,
    sizes: ['1K', '2K', '4K'],
    defaultRatio: '16:9',
    defaultSize: '1K',
    mapSize: mapScaledSizeText,
  },
  'gpt-image-2': {
    label: 'GPT Image 2',
    backend: 'openai_images',
    apiModel: 'gpt-image-2',
    endpoint: '/v1/images/generations',
    ratios: allRatios,
    // 1K≈草稿边长、2K≈文档中的 2048 档、4K≈最长边 3840 且受总像素上限约束（官方列 3840×2160 等）
    sizes: ['1K', '2K', '4K'],
    defaultRatio: '16:9',
    defaultSize: '1K',
    mapSize: mapGptImage2Size,
  },
};

/** 新建节点 / 未保存过模型时的画布默认（Nano banana pro） */
export const DEFAULT_IMAGE_GENERATION_MODEL = 'gemini-3-pro-image-preview';

const PREFERRED_IMAGE_MODEL_STORAGE_PREFIX = 'my-canvas:preferredImageGenerationModel:';

export function getPreferredImageGenerationModel(slug) {
  if (!slug || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(`${PREFERRED_IMAGE_MODEL_STORAGE_PREFIX}${slug}`);
    return raw && imageModelMap[raw] ? raw : null;
  } catch {
    return null;
  }
}

export function setPreferredImageGenerationModel(slug, modelId) {
  if (!slug || typeof window === 'undefined') return;
  if (!imageModelMap[modelId]) return;
  try {
    window.localStorage.setItem(`${PREFERRED_IMAGE_MODEL_STORAGE_PREFIX}${slug}`, modelId);
  } catch {
    /* quota / private mode */
  }
}

/** 节点未持久化 generationModel 时：工程记忆 → 全局默认 */
export function resolveInitialImageGenerationModel(savedModel, projectSlug) {
  if (savedModel && imageModelMap[savedModel]) return savedModel;
  const preferred = getPreferredImageGenerationModel(projectSlug);
  if (preferred) return preferred;
  return DEFAULT_IMAGE_GENERATION_MODEL;
}

/** useState 初始化一次即可：模型 + 比例 + 清晰度 */
export function getInitialImageNodeGenerationState(data, projectSlug) {
  const model = resolveInitialImageGenerationModel(data?.generationModel, projectSlug);
  return {
    model,
    ratio: data?.generationRatio ?? getDefaultRatio(model),
    size: data?.generationSize ?? data?.generationQuality ?? getDefaultSize(model),
  };
}

export const imageModelOptions = Object.keys(imageModelMap).map((id) => ({
  id,
  label: imageModelMap[id].label,
}));

export function getImageModelConfig(model) {
  return imageModelMap[model] || imageModelMap[DEFAULT_IMAGE_GENERATION_MODEL];
}

export function getAllowedRatios(model) {
  return getImageModelConfig(model).ratios;
}

export function getAllowedSizes(model) {
  return getImageModelConfig(model).sizes;
}

export function getDefaultRatio(model) {
  return getImageModelConfig(model).defaultRatio;
}

export function getDefaultSize(model) {
  return getImageModelConfig(model).defaultSize;
}

export function mapUiSizeToApiSize(model, ratio, size) {
  return getImageModelConfig(model).mapSize(ratio, size);
}

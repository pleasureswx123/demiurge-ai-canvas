const buildDurationOptions = (minSeconds, maxSeconds) =>
  Array.from({ length: maxSeconds - minSeconds + 1 }, (_, index) => {
    const seconds = minSeconds + index;
    return {
      label: `${seconds}s`,
      apiValue: seconds,
    };
  });

const commonSeedanceRatios = [
  { label: '自适应', apiValue: 'adaptive' },
  { label: '16:9', apiValue: '16:9' },
  { label: '4:3', apiValue: '4:3' },
  { label: '1:1', apiValue: '1:1' },
  { label: '3:4', apiValue: '3:4' },
  { label: '9:16', apiValue: '9:16' },
  { label: '21:9', apiValue: '21:9' },
];

const commonSeedanceResolutions = [
  { label: '480P', apiValue: '480p' },
  { label: '720P', apiValue: '720p' },
  { label: '1080P', apiValue: '1080p' },
];

const fastSeedanceResolutions = [
  { label: '480P', apiValue: '480p' },
  { label: '720P', apiValue: '720p' },
  { label: '1080P', apiValue: '1080p' },
];

const wanI2VResolutions = [
  { label: '720P', apiValue: '720P' },
  { label: '1080P', apiValue: '1080P' },
];

export const videoModelMap = {
  'wan2.7-i2v': {
    label: 'Wan 2.7 I2V',
    backend: 'dashscope',
    apiModel: 'wan2.7-i2v',
    endpoint: '/api/v1/services/aigc/video-generation/video-synthesis',
    defaultRatio: '16:9',
    defaultResolution: '720P',
    defaultDuration: '5s',
    ratios: commonSeedanceRatios,
    resolutions: wanI2VResolutions,
    durations: buildDurationOptions(2, 10),
    supportsTextToVideo: false,
    supportsImageToVideo: true,
    requiresReferenceImages: true,
    maxInputImages: 2,
    supportsSubjectLibrary: false,
  },
  'seedance-2.0': {
    label: 'Seedance 2.0',
    backend: 'xunke_seedance',
    apiModel: 'seed-2',
    endpoint: '/v1/videos',
    defaultRatio: '16:9',
    defaultResolution: '720P',
    defaultDuration: '5s',
    ratios: commonSeedanceRatios,
    resolutions: commonSeedanceResolutions,
    durations: buildDurationOptions(4, 15),
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    requiresReferenceImages: false,
    maxInputImages: 9,
    supportsSubjectLibrary: false,
  },
  'seedance-2.0-fast': {
    label: 'Seedance 2.0 Fast',
    backend: 'xunke_seedance',
    apiModel: 'seed-2-fast',
    endpoint: '/v1/videos',
    defaultRatio: '16:9',
    defaultResolution: '720P',
    defaultDuration: '5s',
    ratios: commonSeedanceRatios,
    resolutions: fastSeedanceResolutions,
    durations: buildDurationOptions(4, 15),
    supportsTextToVideo: true,
    supportsImageToVideo: true,
    requiresReferenceImages: false,
    maxInputImages: 9,
    supportsSubjectLibrary: false,
  },
};

export const DEFAULT_VIDEO_MODEL_ID = 'seedance-2.0';

export const videoModelOptions = Object.keys(videoModelMap).map((id) => ({
  id,
  label: videoModelMap[id].label,
}));

export const getVideoModelConfig = (modelId) =>
  videoModelMap[modelId] || videoModelMap[DEFAULT_VIDEO_MODEL_ID];

export const getAllowedVideoRatios = (modelId) => getVideoModelConfig(modelId).ratios || [];
export const getAllowedVideoResolutions = (modelId) => getVideoModelConfig(modelId).resolutions || [];
export const getAllowedVideoDurations = (modelId) => getVideoModelConfig(modelId).durations || [];
export const getDefaultVideoRatio = (modelId) => getVideoModelConfig(modelId).defaultRatio;
export const getDefaultVideoResolution = (modelId) => getVideoModelConfig(modelId).defaultResolution;
export const getDefaultVideoDuration = (modelId) => getVideoModelConfig(modelId).defaultDuration;

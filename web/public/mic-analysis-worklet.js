const DEFAULT_METRIC_COUNT = 4;
const DEFAULT_METRIC_SCALE = 1000000;
const LEVEL_INDEX = 0;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.08;
const MESSAGE_INTERVAL_FRAMES = 4;

class MicAnalysisProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const processorOptions = options.processorOptions || {};
    this.metricCount = processorOptions.metricCount || DEFAULT_METRIC_COUNT;
    this.metricScale = processorOptions.metricScale || DEFAULT_METRIC_SCALE;
    this.metrics = new Float32Array(this.metricCount);
    this.sharedMetrics = processorOptions.sharedMetricsBuffer
      ? new Int32Array(processorOptions.sharedMetricsBuffer)
      : null;
    this.envelope = 0;
    this.frameCount = 0;
  }

  process(inputs) {
    const channels = inputs[0] || [];
    const frameCount = channels[0]?.length || 0;
    const rms = frameCount > 0 ? this.readRms(channels, frameCount) : 0;
    const target = Math.min(rms * 2, 1);
    const timeConstant = target > this.envelope ? ATTACK_SECONDS : RELEASE_SECONDS;
    const coefficient = Math.exp(-frameCount / sampleRate / timeConstant);
    this.envelope = target + (this.envelope - target) * coefficient;
    this.metrics[LEVEL_INDEX] = this.envelope;

    this.publishMetrics();
    return true;
  }

  readRms(channels, frameCount) {
    let total = 0;
    let sampleCount = 0;

    for (const channel of channels) {
      for (let index = 0; index < frameCount; index += 1) {
        const sample = channel[index] || 0;
        total += sample * sample;
      }
      sampleCount += frameCount;
    }

    return sampleCount > 0 ? Math.sqrt(total / sampleCount) : 0;
  }

  publishMetrics() {
    if (this.sharedMetrics) {
      for (let index = 0; index < this.metricCount; index += 1) {
        const scaled = Math.round(clampMetric(this.metrics[index]) * this.metricScale);
        Atomics.store(this.sharedMetrics, index, scaled);
      }
      return;
    }

    this.frameCount += 1;
    if (this.frameCount % MESSAGE_INTERVAL_FRAMES !== 0) return;
    this.port.postMessage({
      type: 'metrics',
      metrics: Array.from(this.metrics),
    });
  }
}

function clampMetric(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

registerProcessor('mic-analysis-processor', MicAnalysisProcessor);

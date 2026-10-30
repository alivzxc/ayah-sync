const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;
const FRAME_SHIFT = 160;
const FFT_SIZE = 512;
const MEL_BINS = 80;
const MEL_EPSILON = 1.1920928955078125e-7;

function mel(frequency) {
  return 1127 * Math.log1p(frequency / 700);
}

function createMelBanks() {
  const bins = FFT_SIZE / 2;
  const banks = new Float32Array(MEL_BINS * bins);
  const width = SAMPLE_RATE / FFT_SIZE;
  const low = mel(20);
  const delta = (mel(SAMPLE_RATE / 2 - 400) - low) / (MEL_BINS + 1);
  for (let bank = 0; bank < MEL_BINS; bank++) {
    const left = low + bank * delta;
    const center = low + (bank + 1) * delta;
    const right = low + (bank + 2) * delta;
    for (let bin = 0; bin < bins; bin++) {
      const value = mel(width * bin);
      if (left < value && value < right) {
        banks[bank * bins + bin] = value <= center
          ? (value - left) / (center - left)
          : (right - value) / (right - center);
      }
    }
  }
  return banks;
}

const MEL_BANKS = createMelBanks();
// Each triangular filter covers only a handful of FFT bins. Skipping zero
// weights preserves summation order and feature values, without extra threads.
const MEL_START = new Uint16Array(MEL_BINS);
const MEL_END = new Uint16Array(MEL_BINS);
for (let bank = 0; bank < MEL_BINS; bank++) {
  let start = 0, end = FFT_SIZE / 2;
  const offset = bank * end;
  while (start < end && MEL_BANKS[offset + start] === 0) start++;
  while (end > start && MEL_BANKS[offset + end - 1] === 0) end--;
  MEL_START[bank] = start;
  MEL_END[bank] = end;
}
const WINDOW = Float32Array.from({ length: FRAME_LENGTH }, (_, i) =>
  (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME_LENGTH - 1))) ** 0.85);

function reflect(index, length) {
  if (index < 0) return -index - 1;
  if (index >= length) return 2 * length - index - 1;
  return index;
}

function fft(real, imaginary) {
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imaginary[i], imaginary[j]] = [imaginary[j], imaginary[i]];
    }
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const angle = -2 * Math.PI / size;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < FFT_SIZE; start += size) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < size / 2; offset++) {
        const even = start + offset;
        const odd = even + size / 2;
        const productReal = twiddleReal * real[odd] - twiddleImaginary * imaginary[odd];
        const productImaginary = twiddleReal * imaginary[odd] + twiddleImaginary * real[odd];
        real[odd] = real[even] - productReal;
        imaginary[odd] = imaginary[even] - productImaginary;
        real[even] += productReal;
        imaginary[even] += productImaginary;
        const nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextReal;
      }
    }
  }
}

export function normalizeAudio(audio, peak) {
  const normalized = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) normalized[i] = audio[i] / peak;
  return normalized;
}

export function computeFbank(audio) {
  const frameCount = Math.floor((audio.length + FRAME_SHIFT / 2) / FRAME_SHIFT);
  const features = new Float32Array(frameCount * MEL_BINS);
  const real = new Float32Array(FFT_SIZE);
  const imaginary = new Float32Array(FFT_SIZE);
  const power = new Float32Array(FFT_SIZE / 2);
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * FRAME_SHIFT + FRAME_SHIFT / 2 - FRAME_LENGTH / 2;
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) mean += audio[reflect(start + i, audio.length)];
    mean /= FRAME_LENGTH;
    let previous = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      const value = audio[reflect(start + i, audio.length)] - mean;
      real[i] = (i === 0 ? value * 0.03 : value - 0.97 * previous) * WINDOW[i];
      previous = value;
    }
    real.fill(0, FRAME_LENGTH);
    imaginary.fill(0);
    fft(real, imaginary);
    for (let bin = 0; bin < power.length; bin++) {
      power[bin] = real[bin] * real[bin] + imaginary[bin] * imaginary[bin];
    }
    const out = frame * MEL_BINS;
    for (let bank = 0; bank < MEL_BINS; bank++) {
      let energy = 0;
      const offset = bank * power.length;
      for (let bin = MEL_START[bank]; bin < MEL_END[bank]; bin++) energy += power[bin] * MEL_BANKS[offset + bin];
      features[out + bank] = Math.log(Math.max(energy, MEL_EPSILON));
    }
  }
  return { data: features, frames: frameCount };
}

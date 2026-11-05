import { expect, test } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { createVoiceFilterBank } from './voice-filter';

test('processes audio through RNNoise and stops when the filter is destroyed', async () => {
  const bank = createVoiceFilterBank();
  const context = bank.context;
  const button = document.createElement('button');
  button.textContent = 'Start test audio';
  button.onclick = () => void context.resume();
  document.body.append(button);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const analyser = context.createAnalyser();
  const filter = await bank.create();
  const samples = new Float32Array(analyser.fftSize);
  const level = () => {
    analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  };

  try {
    await userEvent.click(page.getByRole('button', { name: 'Start test audio' }));
    oscillator.frequency.value = 200;
    gain.gain.value = 0.1;
    oscillator.connect(gain).connect(filter).connect(analyser).connect(context.destination);
    oscillator.start();

    await expect.poll(level).toBeGreaterThan(0.001);
    filter.destroy();
    await expect.poll(level).toBe(0);
  } finally {
    oscillator.stop();
    oscillator.disconnect();
    filter.destroy();
    filter.disconnect();
    gain.disconnect();
    analyser.disconnect();
    bank.close();
    button.remove();
  }
});

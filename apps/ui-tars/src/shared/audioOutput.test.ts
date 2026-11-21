import { expect, it } from 'vitest';
import { isSpeakerOutputLabel } from './audioOutput';

it('distinguishes speaker outputs from headphones for both interruption owners', () => {
  for (const label of [
    'MacBook Pro Speakers',
    '内建输出',
    'Bluetooth Speaker',
    'HDMI Display',
  ]) {
    expect(isSpeakerOutputLabel(label)).toBe(true);
  }
  for (const label of [
    'AirPods Pro',
    'Realtek Headphones',
    '蓝牙耳机',
    'USB Headset',
  ]) {
    expect(isSpeakerOutputLabel(label)).toBe(false);
  }
});

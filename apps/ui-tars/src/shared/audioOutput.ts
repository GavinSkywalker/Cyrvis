/** Keep capture and main-process interruption routing consistent. */
export const isSpeakerOutputLabel = (label: string): boolean => {
  const lower = label.toLowerCase();
  if (/cc ultimate|airpods|耳机|耳麦|headset|headphones/.test(lower))
    return false;
  return /realtek|nvidia|扬声器|speaker|digital output|hdmi|display|内建输出|内置输出/.test(
    lower,
  );
};

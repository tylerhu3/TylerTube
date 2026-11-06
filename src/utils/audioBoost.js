// Volume boost steps for the Standard (Plyr) player. A native <video> caps at 100%, so the
// boost is a Web Audio GainNode multiplier applied on top of Plyr's own volume.
export const VOLUME_BOOST_STEPS = [1, 1.5, 2, 3];

export function nextVolumeBoost(current) {
  const i = VOLUME_BOOST_STEPS.indexOf(current);
  return VOLUME_BOOST_STEPS[(i + 1) % VOLUME_BOOST_STEPS.length];
}

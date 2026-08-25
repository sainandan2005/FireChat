'use client';

import { useSyncExternalStore } from 'react';
import DotGrid from './DotGrid';

/* theme colors as module constants — referentially stable for useSyncExternalStore */
const LIGHT = { baseColor: '#d6d4ca', activeColor: '#f54e00' };
const DARK = { baseColor: '#3a382f', activeColor: '#ff6a2b' };

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

function getThemeSnapshot() {
  return document.documentElement.classList.contains('dark') ? DARK : LIGHT;
}

function getServerThemeSnapshot() {
  return LIGHT;
}

function subscribeMotion(onChange: () => void) {
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

function getMotionSnapshot(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function getServerMotionSnapshot(): boolean {
  return false;
}

export default function DotGridBackground() {
  const colors = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getServerThemeSnapshot);
  const reducedMotion = useSyncExternalStore(
    subscribeMotion,
    getMotionSnapshot,
    getServerMotionSnapshot
  );

  if (reducedMotion) return null;

  return (
    <div className="absolute inset-0" aria-hidden>
      <DotGrid
        dotSize={5}
        gap={26}
        baseColor={colors.baseColor}
        activeColor={colors.activeColor}
        proximity={140}
        shockRadius={220}
        shockStrength={4}
        resistance={750}
        returnDuration={1.5}
      />
    </div>
  );
}

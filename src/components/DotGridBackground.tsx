'use client';

import { useEffect, useState } from 'react';
import DotGrid from './DotGrid';

/** Resolves backdrop dot colors for the active theme. */
function useDotColors(): { baseColor: string; activeColor: string } {
  const [colors, setColors] = useState({
    baseColor: '#d6d4ca',
    activeColor: '#f54e00',
  });

  useEffect(() => {
    const read = () => {
      const dark = document.documentElement.classList.contains('dark');
      setColors({
        baseColor: dark ? '#3a382f' : '#d6d4ca',
        activeColor: dark ? '#ff6a2b' : '#f54e00',
      });
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return colors;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

export default function DotGridBackground() {
  const { baseColor, activeColor } = useDotColors();
  const reducedMotion = usePrefersReducedMotion();

  if (reducedMotion) return null;

  return (
    <div className="absolute inset-0" aria-hidden>
      <DotGrid
        dotSize={5}
        gap={26}
        baseColor={baseColor}
        activeColor={activeColor}
        proximity={140}
        shockRadius={220}
        shockStrength={4}
        resistance={750}
        returnDuration={1.5}
      />
    </div>
  );
}

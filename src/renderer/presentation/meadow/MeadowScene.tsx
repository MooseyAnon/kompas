import React from 'react';
import cloud from './assets/meadow-cloud.svg';
import hills from './assets/rolling-hills.svg';
import peachTree from './assets/peach-tree.png';
import sakura from './assets/sakura.png';
import whiteFlower from './assets/single-white-flower.png';
import yellowFlowers from './assets/two-yello-flower.png';
import purpleFlowers from './assets/purple-flower-bunch.png';
import grassTwo from './assets/grass-tuft-2-v1.png';
import grassThree from './assets/grass-tuft-3-v1.png';
import grassThreeAlt from './assets/grass-tuft-3-v2.png';
import grassV from './assets/grass-tuft-V-2.png';
import './MeadowScene.css';

export type SceneDensity = 'full' | 'subtle' | 'none';

/** Decorative, replaceable layer: no route, app or domain dependencies. */
export function MeadowScene({ density }: { density: SceneDensity }) {
  if (density === 'none') return null;

  return (
    <div
      className={`meadow meadow-${density}`}
      aria-hidden="true"
      data-testid="meadow-scene"
    >
      <img
        className="meadow-cloud meadow-cloud-left"
        src={cloud}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-cloud meadow-cloud-middle"
        src={cloud}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-cloud meadow-cloud-right"
        src={cloud}
        alt=""
        draggable={false}
      />
      <img className="meadow-hills" src={hills} alt="" draggable={false} />
      <img className="meadow-tree" src={peachTree} alt="" draggable={false} />
      <img
        className="meadow-flower meadow-white"
        src={whiteFlower}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-flower meadow-yellow"
        src={yellowFlowers}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-flower meadow-purple"
        src={purpleFlowers}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-a"
        src={grassThree}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-b"
        src={grassV}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-c"
        src={grassTwo}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-d"
        src={grassThreeAlt}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-e"
        src={grassV}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-f"
        src={grassTwo}
        alt=""
        draggable={false}
      />
      <img
        className="meadow-grass meadow-grass-g"
        src={grassThree}
        alt=""
        draggable={false}
      />
      <img className="meadow-sakura" src={sakura} alt="" draggable={false} />
    </div>
  );
}

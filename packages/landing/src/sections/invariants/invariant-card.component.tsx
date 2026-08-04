import { motion, useTransform } from 'motion/react';
import { type CSSProperties, useRef } from 'react';

import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';
import { Icon } from '@/shared/ui/icon.component.js';

import { InvariantVisual } from './invariant-visual.component.js';
import classes from './invariant-card.module.css';

interface InvariantCardProps {
  index: number;
  tag: string;
  title: string;
  body: string;
  proof: string;
}

/**
 * One card of the stack.
 *
 * The card sticks near the top of the viewport while the next one scrolls up over it, and it
 * shrinks and dims as that happens — which is what turns four boxes into a deck being dealt. Each
 * card measures its own exit, so the effect does not depend on how many cards there are.
 */
export const InvariantCard = ({ index, tag, title, body, proof }: InvariantCardProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const progress = useSceneProgress(ref, { offset: ['start start', 'end start'] });

  const scale = useTransform(progress, [0, 1], [1, 0.92]);
  const opacity = useTransform(progress, [0, 1], [1, 0.4]);

  return (
    <div
      ref={ref}
      className={classes['slot']}
      style={{ '--bcl-stack-index': index } as CSSProperties}
    >
      <motion.article className={classes['card']} style={{ scale, opacity }}>
        <div className={classes['side']}>
          <span className={classes['tag']}>
            <span className={classes['tagDot']} aria-hidden="true" />
            {tag}
          </span>
          <span className={classes['number']} aria-hidden="true">
            {String(index + 1).padStart(2, '0')}
          </span>
          <InvariantVisual index={index} />
        </div>

        <div className={classes['side']}>
          <h3 className={classes['title']}>{title}</h3>
          <p className={classes['body']}>{body}</p>
          <code className={classes['proof']}>
            <Icon name="caret" className={classes['prompt']} />
            {proof}
          </code>
        </div>
      </motion.article>
    </div>
  );
};

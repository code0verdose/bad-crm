import { motion, useInView, useTransform } from 'motion/react';
import { useEffect, useRef } from 'react';

import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';
import { Icon } from '@/shared/ui/icon.component.js';

import { DomainPreview } from './domain-preview.component.js';
import classes from './domain-panel.module.css';

interface DomainPanelProps {
  /** Position in the list: it picks the abstract picture and reports the active rail entry. */
  index: number;
  name: string;
  summary: string;
  points: string[];
  onEnter: (index: number) => void;
}

/**
 * One domain: the words on the left, an abstract picture of the domain on the right.
 *
 * The card is tied to its own passage through the viewport rather than to a one-shot reveal. It
 * arrives slightly small and dim, is at full size and full contrast while it crosses the middle,
 * and recedes again on the way out — so the column always has exactly one card in focus and the
 * neighbours read as depth. That is the effect Apple's product pages are built on, and it is the
 * reason this section can be a plain scroll and still feel composed.
 *
 * Two viewport watchers, on purpose, because they answer different questions. The transform above
 * is "where is this card". The `useInView` below is "is this the one being read", and it only fires
 * while the card crosses a narrow band through the middle — with the default threshold two cards
 * are in view at once and the rail highlight flicks between them.
 *
 * There is no `01` in the corner. The number lives on the rail, where it is a position in a list of
 * eight; on the card it was the same information printed twice.
 */
export const DomainPanel = ({ index, name, summary, points, onEnter }: DomainPanelProps) => {
  const ref = useRef<HTMLElement>(null);
  const centred = useInView(ref, { margin: '-45% 0px -45% 0px' });

  // Frozen mid-passage under reduced motion: that is the state where the card is fully legible.
  const progress = useSceneProgress(ref, {
    offset: ['start end', 'end start'],
    staticProgress: 0.5,
  });
  const scale = useTransform(progress, [0, 0.35, 0.65, 1], [0.93, 1, 1, 0.93]);
  const opacity = useTransform(progress, [0, 0.28, 0.72, 1], [0.35, 1, 1, 0.35]);

  useEffect(() => {
    if (centred) onEnter(index);
  }, [centred, index, onEnter]);

  return (
    <motion.article ref={ref} className={classes['panel']} style={{ scale, opacity }}>
      <div className={classes['text']}>
        <h3 className={classes['name']}>{name}</h3>
        <p className={classes['summary']}>{summary}</p>

        <ul className={classes['points']}>
          {points.map((point) => (
            <li key={point} className={classes['point']}>
              <span className={classes['check']}>
                <Icon name="check" className={classes['checkIcon']} />
              </span>
              {point}
            </li>
          ))}
        </ul>
      </div>

      <DomainPreview index={index} />
    </motion.article>
  );
};

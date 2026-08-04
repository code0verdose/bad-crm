import { motion, useMotionValue, useTransform } from 'motion/react';
import { Fragment, useEffect, useRef } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT } from '@/shared/lib/motion-presets.constant.js';
import { useReducedMotion } from '@/shared/lib/use-reduced-motion.hook.js';
import { useSceneProgress } from '@/shared/lib/use-scene-progress.hook.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';

import { GraphIcon } from './graph-icon.component.js';
import classes from './graph.module.css';

/**
 * The claim of the whole product, as a horizontal walk: a call becomes a decision becomes a task
 * becomes hours becomes an invoice.
 *
 * The section pins and the vertical scroll is spent travelling sideways along the chain. That is
 * the point of doing it this way rather than as five cards in a row: a chain read left to right,
 * one link at a time, is the argument — five cards on a screen are a feature list.
 *
 * **The travel is measured, not guessed.** It used to be a percentage of the track's own width,
 * which has nothing to do with the container: the last card sailed past the left edge and the
 * scroll kept going. Here the distance is exactly `track − viewport`, so the track comes to rest
 * with the last card's right edge against the container's, and there is nothing left to travel.
 */
export const Graph = () => {
  const { copy } = useLocale();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  /** The heading, which is the one element still bound to the container's measure. */
  const measure = useRef<HTMLDivElement>(null);
  /**
   * How far the track has to travel, as a motion value rather than as React state.
   *
   * State would not work here and the failure is silent: `useTransform(value, fn)` captures the
   * function once, so a `distance` read from a closure stays at its first value — measured as 0 on
   * mount — and the track never moves. Measured on the running page: `scrollWidth` was 1936,
   * `clientWidth` 1248, and the computed transform was `none`. As a motion value the distance is an
   * *input* to the transform, so every change re-runs it.
   */
  const distance = useMotionValue(0);

  // Both boxes change with the window, the language and the font — a `resize` listener would miss
  // the last two.
  useEffect(() => {
    const remeasure = () => {
      const trackWidth = track.current?.scrollWidth ?? 0;
      const host = viewport.current?.getBoundingClientRect();
      const container = measure.current?.getBoundingClientRect();
      if (!host || !container) return;

      // Where the container's right edge falls inside the full-bleed stage. The last card comes to
      // rest exactly there, which is what "inside the container" means for a track that is wider
      // than the container it starts in.
      const containerRight = container.right - host.left;
      distance.set(Math.max(0, trackWidth - containerRight));
    };

    const observer = new ResizeObserver(remeasure);
    if (track.current) observer.observe(track.current);
    if (viewport.current) observer.observe(viewport.current);
    if (measure.current) observer.observe(measure.current);
    remeasure();

    return () => observer.disconnect();
  }, [distance]);

  // Raw progress, not springed: the track is glued to the wheel, and a spring here would feel like
  // the page is dragging behind the reader's finger.
  const progress = useSceneProgress(ref, { offset: ['start start', 'end end'], raw: true });
  /**
   * The transformer takes **only motion values** — no `reduced`, no state.
   *
   * `useTransform` keeps the function from the first render, so anything read out of a closure is
   * frozen at its first value. That is what stopped the track twice: first `distance`, still 0 when
   * the component mounted, and then `reduced`, whose first-render value pinned the output at zero
   * for good. Reduced motion is already handled where it belongs — `useSceneProgress` freezes the
   * progress itself — so the whole expression is a product of two live values.
   */
  const x = useTransform(
    [progress, distance],
    ([value = 0, travel = 0]: number[]) => -value * travel,
  );

  return (
    <PageSection flush labelledBy="graph-heading">
      <div ref={ref} className={classes['scene']}>
        <div className={classes['sticky']}>
          <div ref={measure} className={classes['heading']}>
            <SectionHeading
              title={copy.graph.title}
              subtitle={copy.graph.subtitle}
              id="graph-heading"
            />
          </div>

          <div ref={viewport} className={classes['viewport']}>
            <motion.div ref={track} className={classes['track']} style={{ x }}>
              {copy.graph.nodes.map((node, index) => (
                <Fragment key={node.label}>
                  {index > 0 ? (
                    <motion.span
                      className={classes['connector']}
                      initial={{ scaleX: 0, opacity: 0 }}
                      whileInView={{ scaleX: 1, opacity: 1 }}
                      viewport={{ once: true, amount: 0.8 }}
                      transition={{ duration: 0.5, ease: EASE_OUT }}
                      aria-hidden="true"
                    >
                      {reduced ? null : (
                        <motion.span
                          className={classes['spark']}
                          animate={{ left: ['0%', '100%'], opacity: [0, 1, 0] }}
                          transition={{
                            duration: 1.6,
                            ease: 'easeInOut',
                            repeat: Number.POSITIVE_INFINITY,
                            delay: index * 0.35,
                          }}
                        />
                      )}
                    </motion.span>
                  ) : null}

                  <motion.article
                    className={classes['node']}
                    initial={{ opacity: 0, y: 24 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true, amount: 0.6 }}
                    transition={{ duration: 0.6, ease: EASE_OUT }}
                  >
                    <span className={classes['nodeHead']}>
                      <span className={classes['icon']}>
                        <GraphIcon index={index} className={classes['glyph']} />
                      </span>
                      <span className={classes['step']}>
                        {String(index + 1).padStart(2, '0')} / {copy.graph.nodes.length}
                      </span>
                    </span>

                    <h3 className={classes['nodeLabel']}>{node.label}</h3>
                    <p className={classes['nodeDetail']}>{node.detail}</p>

                    <span className={classes['table']}>{copy.graph.tables[index]}</span>
                  </motion.article>
                </Fragment>
              ))}
            </motion.div>
          </div>

          <div className={classes['heading']}>
            <p className={classes['footnote']}>{copy.graph.footnote}</p>
          </div>
        </div>
      </div>
    </PageSection>
  );
};

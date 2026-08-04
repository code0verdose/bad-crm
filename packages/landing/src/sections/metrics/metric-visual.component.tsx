import clsx from 'clsx';
import { type CSSProperties, type ReactNode } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { Icon } from '@/shared/ui/icon.component.js';

import classes from './metric-visual.module.css';

/**
 * The figure under each claim.
 *
 * Every label here comes from the dictionary rather than being written into the markup: the earlier
 * set left English words ("outbound requests", "0 elsewhere") sitting inside the Russian page, and
 * a reader who does not already know the claim cannot decode a chart whose caption is in another
 * language — or a zero with no unit next to it.
 *
 *   price     — what the same team pays elsewhere, against what it pays here
 *   areas     — the eight domains named, and the rest counted
 *   command   — the command itself
 *   telemetry — the three things products usually phone home about, each switched off
 *   host      — one bar, one host, and what is inside it
 *   seats     — people arriving while the price does not move
 *
 * All of it animates off one custom property the tile flips when the grid comes into view.
 */
export const MetricVisual = ({ index }: { index: number }) => {
  const { copy } = useLocale();
  const v = copy.metrics.visuals;

  const visuals: ReactNode[] = [
    <span className={classes['bars']} key="price">
      {[
        { label: v.priceThem, value: v.priceThemValue, height: '100%', ours: false },
        { label: v.priceUs, value: v.priceUsValue, height: '4%', ours: true },
      ].map((bar) => (
        <span key={bar.label} className={classes['bar']}>
          <span className={classes['barValue']}>{bar.value}</span>
          <span className={classes['barTrack']}>
            <span
              className={clsx(classes['barFill'], bar.ours && classes['barFillAccent'])}
              style={{ '--bcl-bar-height': bar.height } as CSSProperties}
            />
          </span>
          <span className={classes['barLabel']}>{bar.label}</span>
        </span>
      ))}
    </span>,

    <span className={classes['areas']} key="areas">
      {v.areas.map((area) => (
        <span key={area} className={classes['area']}>
          {area}
        </span>
      ))}
      <span className={clsx(classes['area'], classes['areaMore'])}>{v.areasMore}</span>
    </span>,

    <span className={classes['command']} key="command">
      <span className={classes['commandPrompt']}>$</span> docker compose up -d
    </span>,

    // Telemetry: the switches every other product ships on, all in the off position.
    <span className={classes['switches']} key="telemetry">
      {v.telemetryRows.map((row) => (
        <span key={row} className={classes['switchRow']}>
          <span className={classes['switchName']}>{row}</span>
          <span className={classes['switchState']}>{v.telemetryState}</span>
        </span>
      ))}
    </span>,

    <span className={classes['host']} key="host">
      <span className={classes['hostTrack']}>
        <span className={classes['hostFill']} />
      </span>
      <span className={classes['hostName']}>{v.hostName}</span>
      <span className={classes['hostParts']}>
        {v.hostParts.map((part) => (
          <span key={part} className={classes['hostPart']}>
            {part}
          </span>
        ))}
      </span>
    </span>,

    <span className={classes['seats']} key="seats">
      <span className={classes['people']}>
        {Array.from({ length: 16 }, (_unused, personIndex) => (
          <Icon
            key={personIndex}
            name="user"
            className={classes['person']}
            style={{ '--bcl-person-index': personIndex } as CSSProperties}
          />
        ))}
      </span>
      <span className={classes['seatsNote']}>{v.seatsNote}</span>
    </span>,
  ];

  return (
    <div className={classes['visual']} aria-hidden="true">
      {visuals[index % visuals.length]}
    </div>
  );
};

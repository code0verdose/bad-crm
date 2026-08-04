import clsx from 'clsx';
import { type ReactNode } from 'react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { Icon } from '@/shared/ui/icon.component.js';

import classes from './domain-preview.module.css';

/**
 * A small picture of each domain — the thing it actually looks like, not a pattern.
 *
 * The first version was three primitives rearranged eight ways, and it showed: the knowledge-base
 * "graph" was dots at random coordinates with lines that did not join them, which is exactly the
 * thing a graph must not be. These are drawn from the domain instead:
 *
 *   projects  — milestones on a timeline, with progress against each
 *   tasks     — a board where one card is mid-move between columns
 *   documents — a page with a heading, paragraphs and an inline comment
 *   knowledge — a real graph: every edge starts and ends on a node
 *   files     — a file list with types and sizes
 *   time      — a week of hours with a total
 *   chat      — a thread with two sides
 *   vault     — an item list where the values are dots
 *
 * Everything is CSS and text; nothing is an image that could go stale against a design nobody
 * re-exported, and every label comes from the dictionary — a milestone or a column name written
 * into the markup shows up as an English word inside the Russian page.
 */

/** The knowledge graph. Nodes first, then edges expressed as pairs — so a line cannot miss. */
const NODES = [
  { id: 'a', x: 18, y: 22 },
  { id: 'b', x: 62, y: 14 },
  { id: 'c', x: 40, y: 50 },
  { id: 'd', x: 78, y: 58 },
  { id: 'e', x: 20, y: 76 },
  { id: 'f', x: 58, y: 86 },
] as const;

const EDGES = [
  ['a', 'c'],
  ['b', 'c'],
  ['c', 'd'],
  ['c', 'e'],
  ['e', 'f'],
  ['f', 'd'],
] as const;

const nodeById = (id: string) => NODES.find((node) => node.id === id) ?? NODES[0];

/** Geometry, not language: how full each milestone bar and each day of the week is drawn. */
const MILESTONE_PROGRESS = [100, 64, 12];
/** File extensions are not language either — a PDF is a PDF in both dictionaries. */
const FILE_TYPES = ['PDF', 'PNG', 'CSV'];
const WEEK_HOURS = [55, 80, 40, 95, 65];

export const DomainPreview = ({ index }: { index: number }) => {
  const { copy } = useLocale();
  const preview = copy.domains.preview;

  const previews: ReactNode[] = [
    // Projects — milestones with progress.
    <span className={classes['rows']} key="projects">
      {preview.milestones.map((name, milestoneIndex) => (
        <span key={name} className={classes['row']}>
          <span className={classes['rowName']}>{name}</span>
          <span className={classes['meter']}>
            <span
              className={classes['meterFill']}
              style={{ inlineSize: `${MILESTONE_PROGRESS[milestoneIndex] ?? 0}%` }}
            />
          </span>
          <span className={classes['rowValue']}>{MILESTONE_PROGRESS[milestoneIndex] ?? 0}%</span>
        </span>
      ))}
    </span>,

    // Tasks — a board with a card in flight.
    <span className={classes['board']} key="tasks">
      {preview.columns.map((column, columnIndex) => (
        <span key={column} className={classes['column']}>
          <span className={classes['columnName']}>{column}</span>
          {Array.from({ length: columnIndex === 1 ? 2 : 1 }, (_unused, cardIndex) => (
            <span
              key={cardIndex}
              className={clsx(
                classes['card'],
                columnIndex === 1 && cardIndex === 0 && classes['cardMoving'],
              )}
            />
          ))}
        </span>
      ))}
    </span>,

    // Documents — a page with a comment pinned to a line.
    <span className={classes['doc']} key="documents">
      <span className={classes['docHeading']} />
      <span className={classes['docLine']} />
      <span className={clsx(classes['docLine'], classes['docLineShort'])} />
      <span className={classes['docComment']}>
        <span className={classes['docCommentDot']} />
        <span className={classes['docCommentBody']} />
      </span>
      <span className={classes['docLine']} />
    </span>,

    // Knowledge base — a graph whose edges join its nodes.
    <svg
      className={classes['graph']}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      key="knowledge"
    >
      {EDGES.map(([from, to]) => {
        const start = nodeById(from);
        const end = nodeById(to);
        return (
          <line
            key={`${from}-${to}`}
            className={classes['edge']}
            x1={start.x}
            y1={start.y}
            x2={end.x}
            y2={end.y}
          />
        );
      })}
      {NODES.map((node, index) => (
        <circle
          key={node.id}
          className={clsx(classes['node'], index === 2 && classes['nodeHub'])}
          cx={node.x}
          cy={node.y}
          r={index === 2 ? 4.5 : 3}
        />
      ))}
    </svg>,

    // Files — a list with types and sizes.
    <span className={classes['files']} key="files">
      {preview.files.map((file, fileIndex) => (
        <span key={file.name} className={classes['file']}>
          <span className={classes['fileType']}>{FILE_TYPES[fileIndex] ?? 'BIN'}</span>
          <span className={classes['fileName']}>{file.name}</span>
          <span className={classes['fileSize']}>{file.size}</span>
        </span>
      ))}
    </span>,

    // Time — a week, with today taller and a total beside it.
    <span className={classes['week']} key="time">
      {preview.weekdays.map((day, dayIndex) => (
        <span key={dayIndex} className={classes['day']}>
          <span
            className={classes['dayBar']}
            style={{ blockSize: `${WEEK_HOURS[dayIndex] ?? 0}%` }}
          />
          <span className={classes['dayLabel']}>{day}</span>
        </span>
      ))}
      <span className={classes['weekTotal']}>{preview.weekTotal}</span>
    </span>,

    // Chat — a thread with two sides.
    <span className={classes['thread']} key="chat">
      <span className={classes['message']} />
      <span className={clsx(classes['message'], classes['messageOwn'])} />
      <span className={classes['message']} />
      <span className={classes['messageTyping']}>
        <span className={classes['typingDot']} />
        <span className={classes['typingDot']} />
        <span className={classes['typingDot']} />
      </span>
    </span>,

    // Vault — items whose values are never shown.
    <span className={classes['vault']} key="vault">
      {preview.secrets.map((item) => (
        <span key={item} className={classes['secret']}>
          <span className={classes['secretName']}>{item}</span>
          <span className={classes['secretValue']}>••••••••</span>
          <Icon name="lock" className={classes['secretLock']} />
        </span>
      ))}
    </span>,
  ];

  return (
    <div className={classes['preview']} aria-hidden="true">
      {previews[index % previews.length]}
    </div>
  );
};

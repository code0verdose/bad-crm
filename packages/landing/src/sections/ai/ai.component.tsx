import clsx from 'clsx';
import { motion } from 'motion/react';

import { useLocale } from '@/app/i18n/use-locale.hook.js';
import { EASE_OUT, FADE_UP, IN_VIEW, STAGGER } from '@/shared/lib/motion-presets.constant.js';
import { PageSection } from '@/shared/ui/page-section.component.js';
import { SectionHeading } from '@/shared/ui/section-heading.component.js';
import { Icon } from '@/shared/ui/icon.component.js';
import { WindowChrome } from '@/shared/ui/window-chrome.component.js';

import classes from './ai.module.css';

/**
 * The assistant section: a real conversation on the left, the four guarantees on the right.
 *
 * The conversation is the argument. An assistant that can *read* a workspace is a search box; one
 * that can act in it is a colleague — and the only reason that is safe is the thing the tool calls
 * make visible: every call runs under the reader's own token, through the same permission checks as
 * the interface. So the calls are shown, with their arguments, rather than described.
 *
 * The tool names are the shape an MCP server exposes (`tasks.search`, `time.summary`,
 * `tasks.update`) — the page claims a specific integration, so it should look like one.
 */
export const Ai = () => {
  const { copy } = useLocale();

  return (
    <PageSection labelledBy="ai-heading">
      <SectionHeading title={copy.ai.title} subtitle={copy.ai.subtitle} id="ai-heading" />

      <motion.div
        className={classes['connect']}
        variants={STAGGER}
        initial="hidden"
        whileInView="visible"
        viewport={IN_VIEW}
      >
        <motion.p className={classes['connectText']} variants={FADE_UP}>
          {copy.ai.connect}
        </motion.p>

        <motion.div className={classes['clients']} variants={FADE_UP}>
          <span className={classes['clientsLabel']}>{copy.ai.clientsLabel}</span>
          {copy.ai.clients.map((client) => (
            <span key={client} className={classes['client']}>
              {client}
            </span>
          ))}
        </motion.div>
      </motion.div>

      <div className={classes['layout']}>
        <motion.div
          className={classes['window']}
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={IN_VIEW}
          transition={{ duration: 0.6, ease: EASE_OUT }}
        >
          <WindowChrome title={copy.ai.windowTitle} />

          <motion.div
            className={classes['thread']}
            variants={STAGGER}
            initial="hidden"
            whileInView="visible"
            viewport={IN_VIEW}
          >
            <motion.div className={clsx(classes['turn'], classes['turnOwn'])} variants={FADE_UP}>
              <span className={clsx(classes['avatar'], classes['avatarOwn'])}>
                {copy.ai.youInitials}
              </span>
              <span className={classes['bubble']}>{copy.ai.prompt}</span>
            </motion.div>

            <motion.div className={classes['turn']} variants={FADE_UP}>
              <span className={classes['avatar']}>{copy.ai.aiInitials}</span>
              <span className={classes['body']}>
                <span className={classes['bubble']}>{copy.ai.answer}</span>

                <span className={classes['calls']}>
                  <span className={classes['callsLabel']}>{copy.ai.callsLabel}</span>
                  {copy.ai.calls.map((call) => (
                    <span key={call.tool} className={classes['call']}>
                      <span className={classes['callTool']}>{call.tool}</span>
                      <span className={classes['callDetail']}>{call.detail}</span>
                      <Icon name="check" className={classes['callCheck']} />
                    </span>
                  ))}
                </span>
              </span>
            </motion.div>

            <motion.div className={clsx(classes['turn'], classes['turnOwn'])} variants={FADE_UP}>
              <span className={clsx(classes['avatar'], classes['avatarOwn'])}>
                {copy.ai.youInitials}
              </span>
              <span className={classes['bubble']}>{copy.ai.follow}</span>
            </motion.div>

            <motion.div className={classes['turn']} variants={FADE_UP}>
              <span className={classes['avatar']}>{copy.ai.aiInitials}</span>
              <span className={classes['bubble']}>{copy.ai.confirm}</span>
            </motion.div>
          </motion.div>
        </motion.div>

        <motion.ul
          className={classes['points']}
          variants={STAGGER}
          initial="hidden"
          whileInView="visible"
          viewport={IN_VIEW}
        >
          {copy.ai.points.map((point) => (
            <motion.li key={point.title} className={classes['point']} variants={FADE_UP}>
              <span className={classes['pointTitle']}>{point.title}</span>
              <span className={classes['pointBody']}>{point.body}</span>
            </motion.li>
          ))}
        </motion.ul>
      </div>
    </PageSection>
  );
};

import classes from './window-chrome.module.css';

/**
 * The title bar every mock window on this page wears.
 *
 * Three coloured buttons in Apple's order — close, minimise, zoom — with the inner ring and the
 * bevel above them. Grey dots are the tell that a screenshot is a drawing; these cost four
 * declarations and remove it.
 *
 * `aria-hidden`: it is a picture of a window, and the buttons do nothing.
 */
export const WindowChrome = ({ title }: { title?: string | undefined }) => (
  <div className={classes['bar']} aria-hidden="true">
    <span className={classes['lights']}>
      <span className={`${classes['light']} ${classes['close']}`} />
      <span className={`${classes['light']} ${classes['minimise']}`} />
      <span className={`${classes['light']} ${classes['zoom']}`} />
    </span>
    {title ? <span className={classes['title']}>{title}</span> : null}
  </div>
);

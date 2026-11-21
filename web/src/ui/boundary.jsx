// A crash on one screen (or sheet) stays on that screen: the rest of the app keeps working, and the person can
// go back, try again or send a problem report (the error goes into the report's diagnostics).
import { Component } from 'preact';
import { t } from '../core/i18n.js';
import { Icon, Button } from './components.jsx';
import { keepError } from './screens/help.jsx';
import { openSheet, closeSheet, pop } from './state.js';

export class Boundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); keepError(`${this.props.name || 'screen'}: ${error?.stack?.split('\n').slice(0, 3).join(' | ') || error}`); }
  render({ children, sheet = false, name = '' }, { error }) {
    if (!error) return children;
    const again = () => this.setState({ error: null });
    return (
      <div class={sheet ? 'sheet crash' : 'scroll crash'} role="alert" id={`crash-${name}`}>
        <div class="crash-card">
          <span class="crash-ic"><Icon name="info" size={26} stroke={2.2} /></span>
          <h2>{t('crashT')}</h2>
          <p>{t('crashSub')}</p>
          <div class="crash-btns">
            <Button kind="brand" onClick={again} id="crash-again">{t('tryAgain')}</Button>
            <Button kind="secondary" onClick={() => { this.setState({ error: null }); if (sheet) closeSheet(); else pop(); }}>{sheet ? t('close') : t('back')}</Button>
            <Button kind="plain" icon="flag" onClick={() => { if (sheet) closeSheet(); setTimeout(() => openSheet('feedback', { category: 'bug' }), 0); }}>{t('crashReport')}</Button>
          </div>
        </div>
      </div>
    );
  }
}

// Me: who you are on Melovyn, your plan and rewards, and every setting, in one place.
import { useEffect, useState } from 'preact/hooks';
import { useApp, push, openSheet, minutesOn, streakDays } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { Icon, Section, List, Row } from '../components.jsx';
import { hasServer } from '../api.js';
import { ensureAccount } from '../account.js';
import { levelFor } from '../../core/academy.js';
import { isNative } from '../native.js';
import { canInstall, promptInstall, onInstallChange } from '../install.js';

export function MeView({ active }) {
  const s = useApp();
  const me = s.me;
  const online = hasServer();
  const [installable, setInstallable] = useState(canInstall());
  useEffect(() => { if (active && online) ensureAccount({ fresh: true }); }, [active]);
  useEffect(() => onInstallChange(setInstallable), []);
  const tier = me?.tier || 'free';
  const name = (me?.name && me.name !== 'Musician' ? me.name : s.settings.name) || t('yourName');
  const streak = Math.max(streakDays(), me?.streak || 0);
  const week = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return Math.round(minutesOn(d.toISOString().slice(0, 10))); }).reduce((a, b) => a + b, 0);
  const lv = levelFor(s.progress.xp);
  return (
    <div class="scroll" id="me">
      <div class="wrap">
        <header class="me-head">
          <button type="button" class="me-avatar" onClick={() => (online ? push('editProfile') : openSheet('account'))} aria-label={t('editProfile')}>{name.trim().slice(0, 1).toUpperCase()}</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1>{name}</h1>
            <div class="h">{me?.handle ? `@${me.handle} · ` : ''}{instrumentName(s.settings.instrument)}</div>
            <span class={`plan-chip ${tier}`} style={{ marginTop: 6 }}>{tier !== 'free' && <Icon name="crown" size={11} stroke={2.6} />}{t(`plan_${tier}`)}</span>
          </div>
          <button type="button" class="hm-pill" onClick={() => openSheet('account')} aria-label={t('settings')} id="me-settings"><Icon name="gear" size={18} /></button>
        </header>

        <div class="me-stats">
          <button type="button" class="hm-stat" onClick={() => push('history')}><span class="k"><Icon name="flame" size={13} stroke={2.4} />{t('streak')}</span><span class="v num">{streak}</span><span class="s">{t('days')}</span></button>
          <button type="button" class="hm-stat" onClick={() => push('history')}><span class="k"><Icon name="clock" size={13} stroke={2.4} />{t('thisWeek')}</span><span class="v num">{week}</span><span class="s">{t('min')}</span></button>
          <button type="button" class="hm-stat" onClick={() => push('courses')}><span class="k"><Icon name="academy" size={13} stroke={2.4} />{t('level')}</span><span class="v num">{lv.level}</span><span class="s">{s.progress.xp} {t('xp')}</span></button>
        </div>

        {online && me && !me.registered && (
          <div class="signin-card" id="me-signin">
            <div><strong>{t('meSignIn')}</strong><span>{t('meSignInSub')}</span></div>
            <button type="button" class="btn" onClick={() => openSheet('hubRole', {})}><Icon name="person" size={17} stroke={2.4} />{t('signIn')}</button>
          </div>
        )}
        {online && me?.registered && (
          <div class="signed-line"><Icon name="check" size={15} stroke={2.6} />{me.google ? t('signedGoogle', { email: me.email || '' }) : t('signedUser', { handle: me.handle })}
            {!isNative() && <button type="button" class="hw-skip" onClick={() => openSheet('pair', { approve: true })}>{t('pairApproveBtn')}</button>}</div>
        )}

        {tier === 'free' || tier === 'plus' ? (
          <button type="button" class="upsell" id="me-upsell" onClick={() => openSheet('plans')}>
            <Icon name="crown" size={26} stroke={2} />
            <span><strong>{t(tier === 'free' ? 'upsellTitle' : 'upsellTitlePlus')}</strong><span>{t(tier === 'free' ? 'upsellSub' : 'upsellSubPlus')}</span></span>
            <span class="go">{t('seePlans')}</span>
          </button>
        ) : (
          <List><Row icon="crown" color="violet" title={t('yourPlan')} subtitle={me?.tier_until ? t('renewsOn', { d: new Date(me.tier_until).toLocaleDateString() }) : t(`plan_${tier}`)} onClick={() => openSheet('plans')} /></List>
        )}

        {online && (
          <Section>
            <List>
              <Row icon="gift" color="violet" title={t('rewards')} subtitle={t('rewardsRowSub')} detail={me?.credits ?? ''} onClick={() => push('wallet')} id="me-rewards" />
              <Row icon="bell" color="pink" title={t('notifications')} detail={me?.unread || ''} onClick={() => push('notifications')} />
              <Row icon="academy" color="orange" title={t('teachOnMelovyn')} subtitle={t('teachOnMelovynSub')} onClick={() => push('tutorMe')} id="me-teach" />
              <Row icon="check" color="green" title={t('verifyT')} subtitle={s.me?.verified_teacher ? t('verifiedTeacher') : t('verifySub')} onClick={() => openSheet('teacherVerify')} id="me-verify" />
              <Row icon="calendar" color="green" title={t('myLessons')} subtitle={t('myLessonsSub')} onClick={() => push('lessons')} />
              {me?.handle && <Row icon="person" color="blue" title={t('myStagePage')} subtitle={t('myStagePageSub')} onClick={() => push('profile', { handle: me.handle })} />}
            </List>
          </Section>
        )}

        <Section>
          <List>
            <Row icon="summary" color="green" title={t('activity')} subtitle={t('activitySub')} onClick={() => push('history')} />
            <Row icon="tuningfork" color="teal" title={t('tools')} subtitle={t('toolsSub')} onClick={() => push('tools')} />
            <Row icon="gear" color="gray" title={t('settings')} subtitle={t('settingsSub')} onClick={() => openSheet('account')} />
          </List>
        </Section>

        <Section>
          <List>
            {!isNative() && installable && <Row icon="download" color="violet" title={t('installApp')} subtitle={t('installAppSub')} onClick={promptInstall} id="me-install" />}
            <Row icon="quiz" color="teal" title={t('help')} subtitle={t('helpSub')} onClick={() => push('help')} />
            <Row icon="send" color="blue" title={t('sendFeedback')} subtitle={t('sendFeedbackSub')} onClick={() => openSheet('feedback')} />
            <Row icon="info" color="gray" title={t('about')} onClick={() => openSheet('about')} />
            {tier === 'dev' && <Row icon="bolt" color="purple" title={t('devPanel')} subtitle={t('devPanelSub')} onClick={() => push('admin')} />}
          </List>
        </Section>
      </div>
    </div>
  );
}

// Learn: a teacher when you want one (find a tutor, join a class), Hapi the AI tutor, courses, and the
// practice tools. Everything here is extra to the two main things, getting a score and Stage.
import { push, openSheet } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon } from '../components.jsx';
import { LargeTitle } from './common.jsx';
import { AcademyBody } from './academy.jsx';

const dateSeed = () => { const d = new Date(); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); };

export function LearnView({ active }) {
  const tiles = [
    { id: 'ear', icon: 'ear', color: 'orange', title: 'earTraining', sub: 'earTrainingSub', go: () => openSheet('lesson', { lessonId: 'ear2', seed: dateSeed(), daily: true }) },
    { id: 'solo', icon: 'sparkles', color: 'pink', title: 'newSolo', sub: 'newSoloSub', go: () => push('improvise') },
    { id: 'tools', icon: 'tuningfork', color: 'teal', title: 'tools', sub: 'toolsSub', go: () => push('tools') },
  ];
  return (
    <div class="scroll" id="learn">
      <div class="wrap">
        <LargeTitle title={t('learn')} eyebrow={t('learnEyebrow')} />
        <div class="tile-grid">
          {tiles.map((x) => (
            <button type="button" key={x.id} id={`learn-${x.id}`} class={`ftile c-${x.color}`} onClick={x.go}>
              <span class="ic"><Icon name={x.icon} size={21} stroke={2.2} /></span>
              <strong>{t(x.title)}</strong><span>{t(x.sub)}</span>
            </button>
          ))}
        </div>
        <AcademyBody active={active} />
      </div>
    </div>
  );
}

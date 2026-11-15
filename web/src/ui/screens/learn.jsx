// Courses and exercises (More tools): courses with quizzes, ear training, a solo to play over, the practice
// tools, and the way to a tutor. A secondary page: the teaching hub itself is the Learn tab (hub.jsx).
import { push, openSheet } from '../state.js';
import { t } from '../../core/i18n.js';
import { Icon } from '../components.jsx';
import { LargeTitle } from './common.jsx';
import { AcademyBody } from './academy.jsx';

const dateSeed = () => { const d = new Date(); return d.getFullYear() * 400 + d.getMonth() * 32 + d.getDate(); };

export function LearnView({ active, pushed = false }) {
  const tiles = [
    { id: 'tutors', icon: 'users', color: 'violet', title: 'findTutor', sub: 'findTutorSub', go: () => push('tutors') },
    { id: 'lessons', icon: 'calendar', color: 'green', title: 'myLessons', sub: 'myLessonsSub', go: () => push('lessons') },
    { id: 'ear', icon: 'ear', color: 'orange', title: 'earTraining', sub: 'earTrainingSub', go: () => openSheet('lesson', { lessonId: 'ear2', seed: dateSeed(), daily: true }) },
    { id: 'solo', icon: 'sparkles', color: 'pink', title: 'newSolo', sub: 'newSoloSub', go: () => push('improvise') },
    { id: 'tools', icon: 'tuningfork', color: 'teal', title: 'tools', sub: 'toolsSub', go: () => push('tools') },
  ];
  return (
    <div class="scroll" id="learn-more">
      <div class="wrap">
        <LargeTitle title={t('mtExercises')} eyebrow={t('learnEyebrow')} back={pushed} color="orange" />
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

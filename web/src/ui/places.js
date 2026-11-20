// Every place in Haptune, once: the sidebar's Categories, the phone's drawer and the Browse page all use this
// list (like Apple Health's categories). `to` opens it: a tab, or a screen pushed on a tab.
import { go, push, popToRoot } from './state.js';

// gradients run from a deep colour (bottom left, under the white label) to a light one (top right)
export const PLACES = [
  { id: 'library', tab: 'library', icon: 'library', label: 'library', grad: ['#1E5BD8', '#5EA8FF'], to: () => { popToRoot('library'); go('library'); } },
  { id: 'practice', icon: 'mic', label: 'placePractice', grad: ['#E2531F', '#FF9C5B'], to: () => { go('summary'); push('find', {}, 'summary'); } },
  { id: 'create', tab: 'write', icon: 'pencil', label: 'create', grad: ['#0B8C7E', '#3FD3BF'], to: () => { popToRoot('write'); go('write'); } },
  { id: 'courses', icon: 'books', label: 'placeCourses', grad: ['#C2700A', '#F8B84A'], to: () => { go('academy'); push('courses', {}, 'academy'); } },
  { id: 'tutors', icon: 'person', label: 'placeTutors', grad: ['#9333C9', '#D58BFF'], to: () => { go('academy'); push('tutors', {}, 'academy'); } },
  { id: 'improvise', icon: 'improvise', label: 'improvise', grad: ['#5B3FD6', '#9C85FF'], to: () => { go('summary'); push('improvise', {}, 'summary'); } },
  { id: 'tools', icon: 'tuningfork', label: 'tools', grad: ['#16804A', '#4FD58A'], to: () => { go('summary'); push('tools', {}, 'summary'); } },
  { id: 'activity', icon: 'summary', label: 'activity', grad: ['#C8324B', '#FF8FA0'], to: () => { go('summary'); push('history', { metric: 'time' }, 'summary'); } },
  { id: 'help', icon: 'doc', label: 'help', grad: ['#475569', '#94A3B8'], to: () => { go('summary'); push('help', {}, 'summary'); } },
];

/** The places at the top of the sidebar (Health: Summary · Sharing · Browse), never repeated in Categories.
 *  `bar`: also on the phone's tab bar, so the phone's drawer leaves it out. Friends includes the chats. */
export const MAIN = [
  { id: 'home', icon: 'home', label: 'homeTab', tab: 'summary', color: 'violet', bar: true, grad: ['#5B3FD6', '#B79CFF'] },
  { id: 'learn', icon: 'academy', label: 'hub', tab: 'academy', color: 'orange', bar: true, grad: ['#C2560A', '#FFB45C'] },
  { id: 'stage', icon: 'stage', label: 'stage', tab: 'community', color: 'pink', bar: true, grad: ['#D12A58', '#FF7E9C'] },
  { id: 'friends', icon: 'users', label: 'placeFriends', color: 'blue', grad: ['#0A7FC2', '#5CC8F5'], to: () => { go('community'); popToRoot('community'); push('friends', {}, 'community'); } },
  { id: 'browse', icon: 'grid', label: 'browse', color: 'teal', grad: ['#0B8C7E', '#3FD3BF'], to: () => { go('summary'); popToRoot('summary'); push('browse', {}, 'summary'); } },
];
/** On the phone's tab bar (Library and Create are there too), so the drawer doesn't repeat them. */
export const ON_BAR = new Set(['library', 'create']);

export const gradOf = (p) => `linear-gradient(to top right, ${p.grad[0]}, ${p.grad[1]})`;

// Every place in Haptune, once: the sidebar's Categories, the phone's drawer and the Browse page all use this
// list (like Apple Health's categories). `to` opens it: a tab, or a screen pushed on a tab.
import { go, push, popToRoot } from './state.js';

// gradients run from a deep colour (bottom left, under the white label) to a light one (top right)
export const PLACES = [
  { id: 'library', tab: 'library', icon: 'library', label: 'library', grad: ['#1E5BD8', '#5EA8FF'], to: () => { popToRoot('library'); go('library'); } },
  { id: 'practice', icon: 'mic', label: 'placePractice', grad: ['#E2531F', '#FF9C5B'], to: () => { go('summary'); push('find', {}, 'summary'); } },
  { id: 'learn', tab: 'academy', icon: 'academy', label: 'hub', grad: ['#B0399C', '#F07BD8'], to: () => { popToRoot('academy'); go('academy'); } },
  { id: 'create', tab: 'write', icon: 'pencil', label: 'create', grad: ['#0B8C7E', '#3FD3BF'], to: () => { popToRoot('write'); go('write'); } },
  { id: 'stage', tab: 'community', icon: 'stage', label: 'stage', grad: ['#D12A58', '#FF7E9C'], to: () => { popToRoot('community'); go('community'); } },
  { id: 'friends', icon: 'users', label: 'placeFriends', grad: ['#0A7FC2', '#5CC8F5'], to: () => { go('community'); push('friends', {}, 'community'); } },
  { id: 'messages', icon: 'chat', label: 'placeMessages', grad: ['#0E8DA0', '#56D6E6'], to: () => { go('community'); push('messages', {}, 'community'); } },
  { id: 'courses', icon: 'books', label: 'placeCourses', grad: ['#C2700A', '#F8B84A'], to: () => { go('academy'); push('courses', {}, 'academy'); } },
  { id: 'tutors', icon: 'person', label: 'placeTutors', grad: ['#9333C9', '#D58BFF'], to: () => { go('academy'); push('tutors', {}, 'academy'); } },
  { id: 'improvise', icon: 'improvise', label: 'improvise', grad: ['#5B3FD6', '#9C85FF'], to: () => { go('summary'); push('improvise', {}, 'summary'); } },
  { id: 'tools', icon: 'tuningfork', label: 'tools', grad: ['#16804A', '#4FD58A'], to: () => { go('summary'); push('tools', {}, 'summary'); } },
  { id: 'activity', icon: 'summary', label: 'activity', grad: ['#C8324B', '#FF8FA0'], to: () => { go('summary'); push('history', { metric: 'time' }, 'summary'); } },
  { id: 'help', icon: 'doc', label: 'help', grad: ['#475569', '#94A3B8'], to: () => { go('summary'); push('help', {}, 'summary'); } },
];

/** The places at the top of the sidebar (Health: Summary · Sharing · Browse). */
export const MAIN = [
  { id: 'home', icon: 'home', label: 'homeTab', tab: 'summary', color: 'violet' },
  { id: 'friends', icon: 'users', label: 'placeFriends', color: 'blue', to: () => { go('community'); push('friends', {}, 'community'); } },
  { id: 'browse', icon: 'grid', label: 'browse', color: 'teal', to: () => { go('summary'); popToRoot('summary'); push('browse', {}, 'summary'); } },
];

export const gradOf = (p) => `linear-gradient(to top right, ${p.grad[0]}, ${p.grad[1]})`;

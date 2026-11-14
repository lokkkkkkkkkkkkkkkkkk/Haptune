// The song screen's "More…" sheet: the controls most people never need on the first look (parts mixer,
// metronome, which instrument the part is written for, details, editing and export), so the song screen
// itself shows only Play Along, Listen and three everyday controls.
import { closeSheet } from '../state.js';
import { t, instrumentName } from '../../core/i18n.js';
import { List, Row, Toggle } from '../components.jsx';
import { SheetFrame } from './common.jsx';

export function PieceMoreSheet({ parts = 0, mixed = false, metro = false, forInst = '', onMixer, onMetro, onInstrument, onDetails, onEdit, onExport }) {
  const then = (fn) => () => { closeSheet(); setTimeout(() => fn?.(), 0); };
  return (
    <SheetFrame title={t('pieceMoreT')}>
      <List>
        {parts > 0 && <Row id="more-mixer" icon="mixer" color="pink" title={t('mixer')} detail={mixed ? t('on') : t('partsN', { n: parts })} onClick={then(onMixer)} />}
        <Row id="more-metro" icon="metronome" color="teal" title={t('metronome')} chevron={false}
          right={<Toggle id="more-metro-t" checked={metro} label={t('metronome')} onChange={(v) => { onMetro?.(v); closeSheet(); }} />} />
        <Row id="tool-inst" icon="violin" color="blue" title={t('writtenFor')} detail={forInst ? instrumentName(forInst) : t('asWritten')} onClick={then(onInstrument)} />
      </List>
      <List>
        <Row id="more-details" icon="info" color="gray" title={t('details')} onClick={then(onDetails)} />
        {onEdit && <Row id="more-edit" icon="pencil" color="indigo" title={t('editNotes')} onClick={then(onEdit)} />}
        <Row id="more-export" icon="share" color="green" title={t('export')} onClick={then(onExport)} />
      </List>
    </SheetFrame>
  );
}

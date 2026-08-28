import * as React from 'react';
import { MONO } from './constants';

export function Row(props: { label: string; value: string; title?: string }): React.ReactElement {
  return React.createElement(
    'div',
    { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', padding: '1px 0', fontSize: '11px', lineHeight: '16px' } },
    React.createElement('span', { style: { color: '#a1a1aa', flexShrink: 0 } }, props.label),
    React.createElement('span', {
      title: props.title,
      style: {
        fontFamily: MONO,
        color: '#fafafa',
        textAlign: 'right',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        minWidth: 0,
      },
    }, props.value),
  );
}

export function btnStyle(bg: string, disabled: boolean): React.CSSProperties {
  return {
    marginTop: '6px',
    marginRight: '6px',
    padding: '4px 9px',
    borderRadius: '6px',
    border: 'none',
    cursor: disabled ? 'wait' : 'pointer',
    background: bg,
    color: bg === '#f59e0b' ? '#1c1917' : '#fff',
    fontWeight: 600,
    opacity: disabled ? 0.65 : 1,
    fontSize: '11px',
  };
}

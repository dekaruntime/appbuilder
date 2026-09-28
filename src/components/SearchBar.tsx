'use client';
import type { ComponentProps, ReactNode, Ref } from 'react';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onKeyDown?: ComponentProps<'input'>['onKeyDown'];
  inputRef?: Ref<HTMLInputElement>;
  label?: string;
  placeholder?: string;
  className?: string;
  children?: ReactNode;
};

export default function SearchBar({ value, onChange, onSubmit, onKeyDown, inputRef, label = 'Search this computer', placeholder = 'Ask computer anything…', className = '', children }: Props) {
  return <form className={`search search-bar ${className}`} role="search" onSubmit={event => { event.preventDefault(); onSubmit(); }}>
    <input ref={inputRef} aria-label={label} autoComplete="off" spellCheck={false} placeholder={placeholder} value={value} onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
    {children}
  </form>;
}

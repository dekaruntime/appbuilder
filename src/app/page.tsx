'use client';
import AppTitlebar from '../components/AppTitlebar';
import Builder from '../components/Builder';

export default function Home() {
  return <main className="stage"><div className="window">
    <AppTitlebar bare />
    <Builder />
  </div></main>;
}

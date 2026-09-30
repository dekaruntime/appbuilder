'use client';
import AppTitlebar from '../components/AppTitlebar';
import Builder from '../components/Builder';
import TimingCorner from '../components/TimingCorner';

export default function Home() {
  return <main className="stage"><div className="window">
    <AppTitlebar bare />
    <Builder />
    <TimingCorner />
  </div></main>;
}

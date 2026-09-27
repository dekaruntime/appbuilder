'use client';

import { useEffect } from 'react';
import { configureMapLibreWorker } from '@/lib/maplibre-worker';

export function WorkerSetup() {
  useEffect(() => configureMapLibreWorker(), []);
  return null;
}

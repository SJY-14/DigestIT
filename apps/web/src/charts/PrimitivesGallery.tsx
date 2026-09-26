import { formatDuration } from '../feed.js';
import { BarSeries } from './BarSeries.js';
import { DotStrip } from './DotStrip.js';
import { galleryAreas, galleryBarSeries, galleryDays, galleryDotGroups, galleryHeatmap, galleryLineSeries } from './fixtures.js';
import { GridHeatmap } from './GridHeatmap.js';
import { LineSeries } from './LineSeries.js';

/**
 * One of each chart primitive over fixture data, for a visual/screenshot review against the
 * DIG-11 tokens in both color schemes. Not part of the shipped app; mount it directly to view.
 */
export function PrimitivesGallery() {
  return (
    <div className="app gallery">
      <section>
        <h2>Bar series (grouped)</h2>
        <BarSeries categories={galleryDays} series={galleryBarSeries} ariaLabel="Units landed and decided per day" formatCategory={(c) => c.slice(5)} />
      </section>
      <section>
        <h2>Bar series (stacked)</h2>
        <BarSeries categories={galleryDays} series={galleryBarSeries} mode="stacked" ariaLabel="Units landed and decided per day, stacked" formatCategory={(c) => c.slice(5)} />
      </section>
      <section>
        <h2>Line series</h2>
        <LineSeries categories={galleryDays} series={galleryLineSeries} ariaLabel="Unread backlog trend" formatCategory={(c) => c.slice(5)} />
      </section>
      <section>
        <h2>Grid heatmap</h2>
        <GridHeatmap rows={galleryAreas} columns={galleryDays} values={galleryHeatmap} ariaLabel="Units touched per area per day" columnLabelEvery={3} formatColumn={(c) => c.slice(5)} />
      </section>
      <section>
        <h2>Dot strip</h2>
        <DotStrip groups={galleryDotGroups} ariaLabel="Time to open, seconds, by week" formatValue={(v) => formatDuration(v)} />
      </section>
    </div>
  );
}

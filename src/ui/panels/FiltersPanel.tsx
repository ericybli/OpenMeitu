import { useEffect, useState } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { findLayer } from '../../app/store';
import { ORIGINAL_LOOK_ID } from '../../engine/types';
import { listLooks, type LookCategory } from '../../filters/looks';
import type { MessageKey } from '../i18n';
import { PanelSection } from '../components/PanelSection';
import { ParamSlider } from '../components/ParamSlider';
import { CheckIcon } from '../icons';

type CategoryFilter = 'all' | LookCategory | 'custom';

const CATEGORY_LABELS: { readonly [C in LookCategory | 'custom']: MessageKey } = {
  natural: 'filters.category.natural',
  portrait: 'filters.category.portrait',
  film: 'filters.category.film',
  vivid: 'filters.category.vivid',
  mono: 'filters.category.mono',
  creative: 'filters.category.creative',
  custom: 'filters.category.custom',
};

interface Tile {
  lookId: string;
  name: string;
  category: LookCategory | 'custom';
}

export function FiltersPanel() {
  const store = useStore();
  const t = useT();
  const imageId = useEditor((s) => s.imageId);
  const language = useEditor((s) => s.language);
  const thumbnails = useEditor((s) => s.thumbnails);
  const customLooks = useEditor((s) => s.customLooks);
  const filter = useEditor((s) => findLayer(s.doc, 'filter'));
  const [category, setCategory] = useState<CategoryFilter>('all');

  useEffect(() => {
    store.ensureThumbnails();
  }, [store, imageId]);

  const activeLook = filter?.params.lookId ?? ORIGINAL_LOOK_ID;
  const builtIn: Tile[] = listLooks().map((look) => ({ lookId: look.id, name: look.name[language], category: look.category }));
  const tiles: Tile[] = [
    ...builtIn,
    ...customLooks.map((look): Tile => ({ lookId: look.lookId, name: look.name, category: 'custom' })),
  ];
  const present = new Set(tiles.filter((tile) => tile.lookId !== ORIGINAL_LOOK_ID).map((tile) => tile.category));
  const categories = (Object.keys(CATEGORY_LABELS) as (LookCategory | 'custom')[]).filter((c) => present.has(c));
  const visible = tiles.filter(
    (tile) => category === 'all' || tile.lookId === ORIGINAL_LOOK_ID || tile.category === category,
  );

  return (
    <>
      <PanelSection>
        <ParamSlider def={{ kind: 'filter', param: 'intensity', label: 'param.filter.intensity' }} disabled={activeLook === ORIGINAL_LOOK_ID} />
        {activeLook === ORIGINAL_LOOK_ID && <p className="panel-hint">{t('filters.intensityOff')}</p>}
      </PanelSection>
      {categories.length > 1 && (
        <div className="chip-row" role="group" aria-label={t('tool.filters')}>
          {(['all', ...categories] as CategoryFilter[]).map((c) => (
            <button
              key={c}
              type="button"
              className="chip"
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
              data-testid={`look-category-${c}`}
            >
              {c === 'all' ? t('filters.all') : t(CATEGORY_LABELS[c])}
            </button>
          ))}
        </div>
      )}
      <div className="look-grid" data-testid="look-grid">
        {visible.map((tile) => {
          const selected = tile.lookId === activeLook;
          const thumbnail = thumbnails[tile.lookId];
          return (
            <button
              key={tile.lookId}
              type="button"
              className="look-tile"
              aria-pressed={selected}
              onClick={() => store.selectLook(tile.lookId)}
              data-testid={`look-${tile.lookId}`}
              title={tile.name}
            >
              <span className="look-tile__thumb">
                {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <span className="skeleton" />}
                {selected && (
                  <span className="look-tile__check">
                    <CheckIcon size={14} />
                  </span>
                )}
              </span>
              <span className="look-tile__name">{tile.name}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

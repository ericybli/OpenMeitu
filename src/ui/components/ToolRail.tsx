import type { ComponentType } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { TOOLS, type ToolId } from '../../app/store';
import type { MessageKey } from '../i18n';
import { AdjustIcon, BeautyIcon, CropIcon, EffectsIcon, FiltersIcon, PresetsIcon } from '../icons';

export const TOOL_META: { readonly [T in ToolId]: { label: MessageKey; Icon: ComponentType<{ size?: number }> } } = {
  beauty: { label: 'tool.beauty', Icon: BeautyIcon },
  adjust: { label: 'tool.adjust', Icon: AdjustIcon },
  filters: { label: 'tool.filters', Icon: FiltersIcon },
  effects: { label: 'tool.effects', Icon: EffectsIcon },
  crop: { label: 'tool.crop', Icon: CropIcon },
  presets: { label: 'tool.presets', Icon: PresetsIcon },
};

export function ToolRail() {
  const store = useStore();
  const t = useT();
  const active = useEditor((s) => s.tool);

  return (
    <nav className="rail" aria-label={t('tool.navLabel')}>
      {TOOLS.map((tool) => {
        const { label, Icon } = TOOL_META[tool];
        return (
          <button
            key={tool}
            type="button"
            className="rail__item"
            aria-pressed={tool === active}
            onClick={() => store.setTool(tool)}
            data-testid={`tool-${tool}`}
          >
            <Icon size={22} />
            <span>{t(label)}</span>
          </button>
        );
      })}
    </nav>
  );
}

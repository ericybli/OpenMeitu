import { useEffect, useState, type ChangeEvent } from 'react';
import { useEditor, useStore, useT } from '../../app/hooks';
import { presetName, presetThumbnailKey } from '../../app/store';
import { BUILTIN_PRESETS } from '../../engine/preset';
import { PanelSection } from '../components/PanelSection';
import { AlertIcon, CubeIcon, FileExportIcon, FileImportIcon } from '../icons';

export function PresetsPanel() {
  const store = useStore();
  const t = useT();
  const language = useEditor((s) => s.language);
  const imageId = useEditor((s) => s.imageId);
  const thumbnails = useEditor((s) => s.thumbnails);
  const warnings = useEditor((s) => s.presetWarnings);
  const [name, setName] = useState('');

  useEffect(() => {
    store.ensureThumbnails();
  }, [store, imageId]);

  const takeFile = (e: ChangeEvent<HTMLInputElement>, handle: (file: File) => Promise<void>) => {
    const file = e.currentTarget.files?.[0];
    // Reset so choosing the same file again still fires a change event.
    e.currentTarget.value = '';
    if (file) void handle(file);
  };

  return (
    <>
      <PanelSection title={t('presets.builtin')}>
        {BUILTIN_PRESETS.length === 0 ? (
          <p className="panel-hint">{t('presets.empty')}</p>
        ) : (
          <div className="preset-grid">
            {BUILTIN_PRESETS.map((preset, index) => {
              const thumbnail = thumbnails[presetThumbnailKey(index)];
              return (
                <button
                  key={preset.name}
                  type="button"
                  className="look-tile"
                  onClick={() => store.applyPreset(preset)}
                  data-testid={`preset-${index}`}
                >
                  <span className="look-tile__thumb">
                    {thumbnail ? <img src={thumbnail} alt="" draggable={false} /> : <span className="skeleton" />}
                  </span>
                  <span className="look-tile__name">{presetName(preset, language)}</span>
                </button>
              );
            })}
          </div>
        )}
      </PanelSection>

      <PanelSection title={t('presets.mine')}>
        <label className="field">
          <span className="field__label">{t('presets.name')}</span>
          <input
            className="field__input"
            type="text"
            value={name}
            placeholder={t('presets.defaultName')}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={60}
            data-testid="preset-name"
          />
        </label>
        <button
          type="button"
          className="button button--ghost button--block"
          onClick={() => store.exportPreset(name.trim() || t('presets.defaultName'))}
          data-testid="preset-export"
        >
          <FileExportIcon size={18} />
          <span>{t('presets.export')}</span>
        </button>
        <label className="button button--ghost button--block file-button">
          <FileImportIcon size={18} />
          <span>{t('presets.importJson')}</span>
          <input
            type="file"
            accept=".json,application/json"
            className="visually-hidden"
            onChange={(e) => takeFile(e, (file) => store.importPresetFile(file))}
            data-testid="preset-import-input"
          />
        </label>
        <label className="button button--ghost button--block file-button">
          <CubeIcon size={18} />
          <span>{t('presets.importCube')}</span>
          <input
            type="file"
            accept=".cube"
            className="visually-hidden"
            onChange={(e) => takeFile(e, (file) => store.importCubeFile(file))}
            data-testid="lut-import-input"
          />
        </label>
        <p className="panel-hint">{t('presets.lutHint')}</p>
        {warnings.length > 0 && (
          <div className="warning-box" role="status" data-testid="preset-warnings">
            <p className="warning-box__title">
              <AlertIcon size={16} />
              <span>{t('presets.warningsTitle')}</span>
            </p>
            <ul>
              {warnings.map((warning, i) => (
                <li key={i}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
      </PanelSection>
    </>
  );
}

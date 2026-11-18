/**
 * UI strings. `en` defines the key set; `zh` must provide every key (enforced
 * by the `Messages` type). Placeholders use `{name}` syntax.
 */

export type Language = 'en' | 'zh';

const en = {
  'app.tagline': 'Your photos never leave your device',
  'app.loading': 'Opening photo…',

  'header.open': 'Open',
  'header.openTitle': 'Open a photo ({shortcut})',
  'header.undo': 'Undo',
  'header.redo': 'Redo',
  'header.compare': 'Compare',
  'header.compareTitle': 'Hold to see the original (or hold Space)',
  'header.export': 'Export',
  'header.language': 'Switch language',
  'header.github': 'Source code on GitHub',

  'export.title': 'Export photo',
  'export.format': 'Format',
  'export.quality': 'Quality',
  'export.size': '{width} × {height} px',
  'export.download': 'Download',
  'export.working': 'Exporting…',
  'export.done': 'Saved {name}',
  'export.failed': 'Export failed: {detail}',
  'export.pngHint': 'Lossless, larger file',
  'export.unavailable': 'Export needs WebGL2 graphics, which aren’t available right now.',

  'empty.title': 'Drop a photo to start editing',
  'empty.hint': 'or click to choose a file · paste with {shortcut}',
  'empty.choose': 'Choose photo',
  'empty.formats': 'JPEG, PNG, WebP, AVIF, GIF or BMP',
  'empty.featureBeauty': 'Portrait retouching',
  'empty.featureColor': 'Colour & filters',
  'empty.featureCrop': 'Crop & export',
  'empty.dropOverlay': 'Drop to open',

  'tool.beauty': 'Beauty',
  'tool.adjust': 'Adjust',
  'tool.filters': 'Filters',
  'tool.effects': 'Effects',
  'tool.crop': 'Crop',
  'tool.presets': 'Presets',
  'tool.navLabel': 'Tools',

  'section.skin': 'Skin',
  'section.face': 'Face',
  'section.light': 'Light',
  'section.color': 'Colour',
  'section.sharpen': 'Sharpen',
  'section.vignette': 'Vignette',
  'section.grain': 'Grain',

  'param.skinSmooth.amount': 'Smooth',
  'param.skinSmooth.detail': 'Keep texture',
  'param.skinWhiten.amount': 'Whiten',
  'param.teethWhiten.amount': 'Teeth',
  'param.faceReshape.slim': 'Slim face',
  'param.faceReshape.eyes': 'Bigger eyes',
  'param.faceReshape.nose': 'Slim nose',
  'param.faceReshape.chin': 'Chin',
  'param.adjust.exposure': 'Exposure',
  'param.adjust.contrast': 'Contrast',
  'param.adjust.highlights': 'Highlights',
  'param.adjust.shadows': 'Shadows',
  'param.adjust.saturation': 'Saturation',
  'param.adjust.vibrance': 'Vibrance',
  'param.adjust.temperature': 'Temperature',
  'param.adjust.tint': 'Tint',
  'param.filter.intensity': 'Intensity',
  'param.sharpen.amount': 'Amount',
  'param.sharpen.radius': 'Radius',
  'param.vignette.amount': 'Amount',
  'param.vignette.midpoint': 'Midpoint',
  'param.vignette.feather': 'Feather',
  'param.grain.amount': 'Amount',
  'param.grain.size': 'Size',

  'slider.resetTitle': 'Double-click to reset',

  'face.idle': 'Open a photo to detect faces',
  'face.detecting': 'Detecting face…',
  'face.found': 'Face detected',
  'face.foundMany': '{count} faces detected · all are retouched',
  'face.none': 'No face found',
  'face.error': 'Face detection unavailable',
  'face.toolsOffNone': 'Teeth and face-shape tools need a clearly visible face.',
  'face.toolsOffDetecting': 'Face tools unlock once detection finishes.',
  'face.toolsOffError': 'Face tools are off: {detail}',

  'filters.all': 'All',
  'filters.category.natural': 'Natural',
  'filters.category.portrait': 'Portrait',
  'filters.category.film': 'Film',
  'filters.category.vivid': 'Vivid',
  'filters.category.mono': 'Mono',
  'filters.category.creative': 'Creative',
  'filters.category.custom': 'Imported',
  'filters.intensityOff': 'Pick a filter to adjust its intensity.',

  'crop.rotateLeft': 'Rotate left',
  'crop.rotateRight': 'Rotate right',
  'crop.flipH': 'Flip horizontal',
  'crop.flipV': 'Flip vertical',
  'crop.aspect': 'Aspect ratio',
  'crop.aspect.free': 'Free',
  'crop.aspect.original': 'Original',
  'crop.reset': 'Reset crop & rotation',
  'crop.hint':
    'Drag the frame to move it, or its edges and corners to resize. With the keyboard, arrow keys move the frame (Shift for bigger steps), {alt}+arrows move the right or bottom edge and {alt}+Shift+arrows the left or top edge.',
  'crop.geometry': 'Rotate & flip',
  'crop.size': 'Output {width} × {height} px',
  'crop.frame': 'Crop frame',

  'presets.builtin': 'One-tap looks',
  'presets.empty': 'No built-in presets available.',
  'presets.mine': 'Your presets & LUTs',
  'presets.name': 'Preset name',
  'presets.defaultName': 'My preset',
  'presets.export': 'Export current as .json',
  'presets.importJson': 'Import preset (.json)',
  'presets.importCube': 'Import LUT (.cube)',
  'presets.applied': 'Applied “{name}”',
  'presets.saved': 'Saved {name}',
  'presets.invalid': 'Not a valid preset: {detail}',
  'presets.warnings': 'Imported “{name}” with {count} warning(s)',
  'presets.warningsTitle': 'Import warnings',
  'presets.lutImported': 'Imported LUT “{name}” — find it under Filters',
  'presets.lutInvalid': 'Could not read the LUT: {detail}',
  'presets.lutHint': 'Imported LUTs are kept for this session and applied as a filter.',
  'presets.missingLut': 'This preset uses an imported LUT (“{name}”) that isn’t loaded here, so its filter was skipped.',
  'presets.lutNotShared': 'Imported LUTs aren’t stored in presets. Share the .cube file along with this preset.',

  'edits.title': 'Edits',
  'edits.empty': 'No edits yet',
  'edits.emptyHint': 'Every change you make shows up here, so you can hide, fade or remove it.',
  'edits.visible': 'Show or hide {name}',
  'edits.opacity': 'Opacity',
  'edits.reset': 'Reset {name}',
  'edits.delete': 'Remove {name}',
  'edits.resetAll': 'Reset all',
  'edits.skipped': 'Needs a face',

  'layer.skinSmooth': 'Smooth skin',
  'layer.skinWhiten': 'Whiten',
  'layer.teethWhiten': 'Teeth',
  'layer.faceReshape': 'Face shape',
  'layer.adjust': 'Adjust',
  'layer.filter': 'Filter',
  'layer.sharpen': 'Sharpen',
  'layer.vignette': 'Vignette',
  'layer.grain': 'Grain',
  'layer.transform': 'Crop & rotate',

  'canvas.label': 'Photo preview',
  'canvas.original': 'Original',
  'canvas.webglTitle': 'WebGL2 is not available',
  'canvas.webglHint': 'OpenMeitu edits photos on your GPU. Try a recent Chrome, Edge, Firefox or Safari and make sure hardware acceleration is turned on.',

  'toast.notImage': '“{name}” is not an image.',
  'toast.decodeFailed': 'Couldn’t open “{name}”. The file may be damaged or in an unsupported format.',
  'toast.heic': 'HEIC photos can only be opened in Safari. Please convert “{name}” to JPEG first.',
  'toast.largeImage': 'Large photo: editing and exporting at {width} × {height} px (your GPU’s limit).',
  'toast.renderFailed': 'Rendering failed: {detail}',
  'toast.openFailed': 'Couldn’t prepare “{name}” for editing: {detail}',
  'toast.contextLost': 'The graphics processor was reset. Restoring the preview…',
  'toast.dismiss': 'Dismiss',

  'confirm.discardEdits': 'Open “{name}”? Your edits to the current photo will be discarded.',

  'crash.title': 'Something went wrong',
  'crash.hint': 'OpenMeitu hit an unexpected error. Your photo was never uploaded; reload the page to start again.',
  'crash.reload': 'Reload',
} as const;

export type MessageKey = keyof typeof en;
type Messages = { readonly [K in MessageKey]: string };

const zh: Messages = {
  'app.tagline': '照片仅在本地处理，不会上传',
  'app.loading': '正在打开照片…',

  'header.open': '打开',
  'header.openTitle': '打开照片（{shortcut}）',
  'header.undo': '撤销',
  'header.redo': '重做',
  'header.compare': '对比',
  'header.compareTitle': '按住查看原图（或按住空格键）',
  'header.export': '导出',
  'header.language': '切换语言',
  'header.github': '在 GitHub 查看源代码',

  'export.title': '导出照片',
  'export.format': '格式',
  'export.quality': '画质',
  'export.size': '{width} × {height} 像素',
  'export.download': '下载',
  'export.working': '正在导出…',
  'export.done': '已保存 {name}',
  'export.failed': '导出失败：{detail}',
  'export.pngHint': '无损，文件较大',
  'export.unavailable': '导出需要 WebGL2 图形支持，当前不可用。',

  'empty.title': '拖入照片，开始编辑',
  'empty.hint': '或点击选择文件 · 也可按 {shortcut} 粘贴',
  'empty.choose': '选择照片',
  'empty.formats': '支持 JPEG、PNG、WebP、AVIF、GIF、BMP',
  'empty.featureBeauty': '人像美颜',
  'empty.featureColor': '调色与滤镜',
  'empty.featureCrop': '裁剪与导出',
  'empty.dropOverlay': '松开即可打开',

  'tool.beauty': '美颜',
  'tool.adjust': '调色',
  'tool.filters': '滤镜',
  'tool.effects': '效果',
  'tool.crop': '裁剪',
  'tool.presets': '预设',
  'tool.navLabel': '工具',

  'section.skin': '肌肤',
  'section.face': '五官',
  'section.light': '光线',
  'section.color': '色彩',
  'section.sharpen': '锐化',
  'section.vignette': '暗角',
  'section.grain': '颗粒',

  'param.skinSmooth.amount': '磨皮',
  'param.skinSmooth.detail': '保留质感',
  'param.skinWhiten.amount': '美白',
  'param.teethWhiten.amount': '美牙',
  'param.faceReshape.slim': '瘦脸',
  'param.faceReshape.eyes': '大眼',
  'param.faceReshape.nose': '瘦鼻',
  'param.faceReshape.chin': '下巴',
  'param.adjust.exposure': '曝光',
  'param.adjust.contrast': '对比度',
  'param.adjust.highlights': '高光',
  'param.adjust.shadows': '阴影',
  'param.adjust.saturation': '饱和度',
  'param.adjust.vibrance': '自然饱和度',
  'param.adjust.temperature': '色温',
  'param.adjust.tint': '色调',
  'param.filter.intensity': '强度',
  'param.sharpen.amount': '强度',
  'param.sharpen.radius': '半径',
  'param.vignette.amount': '强度',
  'param.vignette.midpoint': '范围',
  'param.vignette.feather': '羽化',
  'param.grain.amount': '强度',
  'param.grain.size': '颗粒大小',

  'slider.resetTitle': '双击恢复默认值',

  'face.idle': '打开照片后自动识别人脸',
  'face.detecting': '正在识别人脸…',
  'face.found': '已识别人脸',
  'face.foundMany': '识别到 {count} 张人脸 · 全部美颜',
  'face.none': '未识别到人脸',
  'face.error': '人脸识别不可用',
  'face.toolsOffNone': '美牙和脸型工具需要清晰可见的人脸。',
  'face.toolsOffDetecting': '人脸识别完成后即可使用面部工具。',
  'face.toolsOffError': '面部工具不可用：{detail}',

  'filters.all': '全部',
  'filters.category.natural': '自然',
  'filters.category.portrait': '人像',
  'filters.category.film': '胶片',
  'filters.category.vivid': '鲜艳',
  'filters.category.mono': '黑白',
  'filters.category.creative': '创意',
  'filters.category.custom': '已导入',
  'filters.intensityOff': '选择一个滤镜后可调节强度。',

  'crop.rotateLeft': '向左旋转',
  'crop.rotateRight': '向右旋转',
  'crop.flipH': '水平翻转',
  'crop.flipV': '垂直翻转',
  'crop.aspect': '裁剪比例',
  'crop.aspect.free': '自由',
  'crop.aspect.original': '原比例',
  'crop.reset': '还原裁剪与旋转',
  'crop.hint':
    '拖动裁剪框可移动位置，拖动边和角可调整大小。键盘操作：方向键移动裁剪框（按住 Shift 步幅更大），{alt}+方向键移动右边或下边，{alt}+Shift+方向键移动左边或上边。',
  'crop.geometry': '旋转与翻转',
  'crop.size': '输出 {width} × {height} 像素',
  'crop.frame': '裁剪框',

  'presets.builtin': '一键美化',
  'presets.empty': '暂无内置预设。',
  'presets.mine': '我的预设与 LUT',
  'presets.name': '预设名称',
  'presets.defaultName': '我的预设',
  'presets.export': '将当前效果导出为 .json',
  'presets.importJson': '导入预设（.json）',
  'presets.importCube': '导入 LUT（.cube）',
  'presets.applied': '已应用「{name}」',
  'presets.saved': '已保存 {name}',
  'presets.invalid': '预设文件无效：{detail}',
  'presets.warnings': '已导入「{name}」，有 {count} 条提示',
  'presets.warningsTitle': '导入提示',
  'presets.lutImported': '已导入 LUT「{name}」，可在“滤镜”中找到',
  'presets.lutInvalid': '无法读取 LUT：{detail}',
  'presets.lutHint': '导入的 LUT 仅在本次会话中保留，并作为滤镜使用。',
  'presets.missingLut': '此预设使用的导入 LUT（「{name}」）在这里没有加载，已跳过该滤镜。',
  'presets.lutNotShared': '预设不包含导入的 LUT，分享时请一并提供对应的 .cube 文件。',

  'edits.title': '效果图层',
  'edits.empty': '还没有任何编辑',
  'edits.emptyHint': '你的每一项调整都会显示在这里，可随时隐藏、调淡或删除。',
  'edits.visible': '显示或隐藏「{name}」',
  'edits.opacity': '不透明度',
  'edits.reset': '重置「{name}」',
  'edits.delete': '删除「{name}」',
  'edits.resetAll': '全部还原',
  'edits.skipped': '需要人脸',

  'layer.skinSmooth': '磨皮',
  'layer.skinWhiten': '美白',
  'layer.teethWhiten': '美牙',
  'layer.faceReshape': '脸型',
  'layer.adjust': '调色',
  'layer.filter': '滤镜',
  'layer.sharpen': '锐化',
  'layer.vignette': '暗角',
  'layer.grain': '颗粒',
  'layer.transform': '裁剪与旋转',

  'canvas.label': '照片预览',
  'canvas.original': '原图',
  'canvas.webglTitle': '当前浏览器不支持 WebGL2',
  'canvas.webglHint': 'OpenMeitu 使用 GPU 在本地处理照片。请使用新版 Chrome、Edge、Firefox 或 Safari，并开启硬件加速。',

  'toast.notImage': '「{name}」不是图片文件。',
  'toast.decodeFailed': '无法打开「{name}」，文件可能已损坏或格式不受支持。',
  'toast.heic': '只有 Safari 能打开 HEIC 照片，请先将「{name}」转换为 JPEG。',
  'toast.largeImage': '照片尺寸较大：将以 {width} × {height} 像素编辑和导出（受 GPU 限制）。',
  'toast.renderFailed': '渲染失败：{detail}',
  'toast.openFailed': '无法编辑「{name}」：{detail}',
  'toast.contextLost': '图形处理器已重置，正在恢复预览…',
  'toast.dismiss': '关闭',

  'confirm.discardEdits': '打开「{name}」？当前照片的修图效果将被丢弃。',

  'crash.title': '出错了',
  'crash.hint': 'OpenMeitu 遇到了意外错误。照片从未上传，请刷新页面后重新开始。',
  'crash.reload': '刷新页面',
};

const DICTIONARIES: { readonly [L in Language]: Messages } = { en, zh };

export type MessageParams = Readonly<Record<string, string | number>>;

export function translate(language: Language, key: MessageKey, params?: MessageParams): string {
  const template = DICTIONARIES[language][key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export function isLanguage(value: unknown): value is Language {
  return value === 'en' || value === 'zh';
}

/** `zh*` browser locales get Chinese, everything else English. */
export function languageFromLocale(locale: string | undefined): Language {
  return locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** BCP 47 tag for `<html lang>`. */
export function htmlLang(language: Language): string {
  return language === 'zh' ? 'zh-CN' : 'en';
}

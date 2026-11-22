import * as ExcelJS from 'exceljs';
import {
  IMAGE_COLUMNS,
  IMAGE_KIND_WORDS,
  inLang,
  MEASURE_WORDS,
  NO_BRAND,
  plain,
  PRODUCT_COLUMNS,
  QTY_PREFIX,
  SHEETS,
  SIZE_SYSTEM_WORDS,
  SPEC_FIELD_WORDS,
  SPEC_PREFIX,
  SPEC_VALUE_WORDS,
  VERSION_COLUMNS,
  type Words,
} from './import-labels';

/**
 * The product import's XLSX file: the template a store downloads (its own
 * branches, collections, brands and the platform lists, in the owner's
 * language) and reading an uploaded file back to rows. No SKU,
 * EAN/MPN or JSON anywhere; «رقم المنتج في الملف» only links the sheets.
 */

export interface TemplateLists {
  lang: 'ar' | 'en';
  branches: { id: string; name: string }[];
  audiences: Words[];
  categories: Words[];
  colorFamilies: Words[];
  sizes: { label: string; system: string }[];
  brands: string[];
  collections: Words[];
  specFields: string[];
  measureKeys: string[];
  /** Fabric composition: the fibres' names, and the countries (common ones first) - in the template's language. */
  fibers: string[];
  countries: string[];
}

const DATA_ROWS = 500;
const WINE = 'FF64283B';
const SAND = 'FFF3E9D7';

function header(
  ws: ExcelJS.Worksheet,
  labels: string[],
  required: Set<number>,
) {
  const row = ws.getRow(1);
  labels.forEach((label, i) => {
    const cell = row.getCell(i + 1);
    cell.value = required.has(i) ? `${label} *` : label;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WINE } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    ws.getColumn(i + 1).width = Math.max(14, Math.min(34, label.length + 6));
  });
  row.height = 32;
  ws.views = [
    { state: 'frozen', ySplit: 1, rightToLeft: ws.views?.[0]?.rightToLeft },
  ];
}

/** A drop-down list on a column, from a column of the hidden lists sheet. */
function listOn(
  ws: ExcelJS.Worksheet,
  col: number,
  listsName: string,
  listCol: string,
  count: number,
) {
  if (count === 0) return;
  const ref = `'${listsName}'!$${listCol}$2:$${listCol}$${count + 1}`;
  for (let r = 2; r <= DATA_ROWS + 1; r += 1) {
    ws.getCell(r, col).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae: [ref],
      showErrorMessage: false,
    };
  }
}

const colLetter = (n: number) => {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};

export async function buildTemplate(l: TemplateLists): Promise<Buffer> {
  const L = l.lang;
  const rtl = L === 'ar';
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FinalPro';

  const listsName = inLang(SHEETS.lists, L);
  // the lists first (hidden at the end), so the other sheets can point at them
  const lists: { key: string; title: string; values: string[] }[] = [
    {
      key: 'audience',
      title: inLang(PRODUCT_COLUMNS.audience, L),
      values: l.audiences.map((w) => inLang(w, L)),
    },
    {
      key: 'category',
      title: inLang(PRODUCT_COLUMNS.category, L),
      values: l.categories.map((w) => inLang(w, L)),
    },
    {
      key: 'brand',
      title: inLang(PRODUCT_COLUMNS.brand, L),
      values: [inLang(NO_BRAND, L), ...l.brands],
    },
    {
      key: 'size_system',
      title: inLang(PRODUCT_COLUMNS.size_system, L),
      values: Object.values(SIZE_SYSTEM_WORDS).map((w) => inLang(w, L)),
    },
    {
      key: 'family',
      title: inLang(VERSION_COLUMNS.color_family, L),
      values: l.colorFamilies.map((w) => inLang(w, L)),
    },
    {
      key: 'size',
      title: inLang(VERSION_COLUMNS.size, L),
      values: l.sizes.map((s) => s.label),
    },
    {
      key: 'collections',
      title: inLang(PRODUCT_COLUMNS.collections, L),
      values: l.collections.map((w) => inLang(w, L)),
    },
    {
      key: 'country',
      title: inLang(PRODUCT_COLUMNS.country_of_origin, L),
      values: l.countries,
    },
    {
      key: 'fiber',
      title: L === 'en' ? 'Fibres' : 'الألياف',
      values: l.fibers,
    },
    {
      key: 'image_kind',
      title: inLang(IMAGE_COLUMNS.kind, L),
      values: Object.values(IMAGE_KIND_WORDS).map((w) => inLang(w, L)),
    },
    ...Object.entries(SPEC_VALUE_WORDS).map(([field, values]) => ({
      key: `spec:${field}`,
      title: inLang(SPEC_FIELD_WORDS[field], L),
      values: Object.values(values).map((w) => inLang(w, L)),
    })),
  ];
  const listCol = new Map<string, { col: string; count: number }>();
  lists.forEach((x, i) =>
    listCol.set(x.key, { col: colLetter(i + 1), count: x.values.length }),
  );

  // «المنتجات»
  const products = wb.addWorksheet(inLang(SHEETS.products, L), {
    views: [{ rightToLeft: rtl }],
  });
  const productKeys = Object.keys(
    PRODUCT_COLUMNS,
  ) as (keyof typeof PRODUCT_COLUMNS)[];
  const productLabels = [
    ...productKeys.map((k) => inLang(PRODUCT_COLUMNS[k], L)),
    ...l.specFields.map(
      (f) => `${inLang(SPEC_PREFIX, L)}${inLang(SPEC_FIELD_WORDS[f], L)}`,
    ),
  ];
  const requiredProduct = new Set(
    [
      'ref',
      'title_ar',
      'audience',
      'category',
      'brand',
      'price',
      'size_system',
    ].map((k) => productKeys.indexOf(k as keyof typeof PRODUCT_COLUMNS)),
  );
  header(products, productLabels, requiredProduct);
  // the barcode column as TEXT: Excel would otherwise drop a leading zero (UPC) or show 4.00638E+12
  products.getColumn(productKeys.indexOf('barcode') + 1).numFmt = '@';
  const pCol = (k: string) =>
    productKeys.indexOf(k as keyof typeof PRODUCT_COLUMNS) + 1;
  for (const [key, list] of [
    ['audience', 'audience'],
    ['category', 'category'],
    ['brand', 'brand'],
    ['size_system', 'size_system'],
    ['country_of_origin', 'country'],
  ] as const) {
    const lc = listCol.get(list)!;
    listOn(products, pCol(key), listsName, lc.col, lc.count);
  }
  l.specFields.forEach((f, i) => {
    const lc = listCol.get(`spec:${f}`);
    // care takes several values (separated by «،») - no single-choice list there
    if (lc && f !== 'care')
      listOn(products, productKeys.length + i + 1, listsName, lc.col, lc.count);
  });

  // «الألوان والمقاسات»
  const versions = wb.addWorksheet(inLang(SHEETS.versions, L), {
    views: [{ rightToLeft: rtl }],
  });
  const versionKeys = Object.keys(
    VERSION_COLUMNS,
  ) as (keyof typeof VERSION_COLUMNS)[];
  const versionLabels = [
    ...versionKeys.map((k) => inLang(VERSION_COLUMNS[k], L)),
    ...l.branches.map((b) => `${inLang(QTY_PREFIX, L)}${b.name}`),
  ];
  header(
    versions,
    versionLabels,
    new Set(
      ['ref', 'color_name_ar', 'color_family', 'size'].map((k) =>
        versionKeys.indexOf(k as keyof typeof VERSION_COLUMNS),
      ),
    ),
  );
  const vCol = (k: string) =>
    versionKeys.indexOf(k as keyof typeof VERSION_COLUMNS) + 1;
  listOn(
    versions,
    vCol('color_family'),
    listsName,
    listCol.get('family')!.col,
    listCol.get('family')!.count,
  );
  listOn(
    versions,
    vCol('size'),
    listsName,
    listCol.get('size')!.col,
    listCol.get('size')!.count,
  );

  // «الصور»: one row per image, the file named as it is inside the ZIP
  const imagesSheet = wb.addWorksheet(inLang(SHEETS.images, L), {
    views: [{ rightToLeft: rtl }],
  });
  const imageKeys = Object.keys(
    IMAGE_COLUMNS,
  ) as (keyof typeof IMAGE_COLUMNS)[];
  header(
    imagesSheet,
    imageKeys.map((k) => inLang(IMAGE_COLUMNS[k], L)),
    new Set(
      (['ref', 'file', 'kind'] as const).map((k) => imageKeys.indexOf(k)),
    ),
  );
  imagesSheet.getColumn(imageKeys.indexOf('file') + 1).width = 34;
  listOn(
    imagesSheet,
    imageKeys.indexOf('kind') + 1,
    listsName,
    listCol.get('image_kind')!.col,
    listCol.get('image_kind')!.count,
  );

  // «جدول القياسات» (optional)
  const measures = wb.addWorksheet(inLang(SHEETS.measurements, L), {
    views: [{ rightToLeft: rtl }],
  });
  header(
    measures,
    [
      inLang(PRODUCT_COLUMNS.ref, L),
      inLang(VERSION_COLUMNS.size, L),
      ...l.measureKeys.map((k) => inLang(MEASURE_WORDS[k], L)),
    ],
    new Set([0, 1]),
  );

  // «التعليمات»
  const help = wb.addWorksheet(inLang(SHEETS.instructions, L), {
    views: [{ rightToLeft: rtl }],
  });
  help.getColumn(1).width = 110;
  const lines = L === 'en' ? INSTRUCTIONS_EN : INSTRUCTIONS_AR;
  lines.forEach((text, i) => {
    const cell = help.getCell(i + 1, 1);
    cell.value = text;
    cell.alignment = { wrapText: true, vertical: 'top' };
    if (i === 0) cell.font = { bold: true, size: 14, color: { argb: WINE } };
    else if (text.startsWith('■')) {
      cell.font = { bold: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: SAND },
      };
    }
  });

  // «القوائم» (hidden)
  const listSheet = wb.addWorksheet(listsName, { state: 'hidden' });
  lists.forEach((x, i) => {
    listSheet.getCell(1, i + 1).value = x.title;
    x.values.forEach((v, j) => (listSheet.getCell(j + 2, i + 1).value = v));
  });

  // the products sheet opens first
  wb.views = [
    {
      x: 0,
      y: 0,
      width: 10000,
      height: 20000,
      firstSheet: 0,
      activeTab: 0,
      visibility: 'visible',
    },
  ];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const INSTRUCTIONS_AR = [
  'استيراد منتجات من ملف - التعليمات',
  '■ الخطوات',
  '1) املئي ورقة «المنتجات»: سطر واحد لكل منتج. «رقم المنتج في الملف» رقم تختارينه أنتِ (1، 2، 3...) يربط المنتج بألوانه ومقاساته وصوره في هذا الملف فقط.',
  '2) املئي ورقة «الألوان والمقاسات»: سطر لكل لون × مقاس، بنفس «رقم المنتج في الملف». اكتبي الكمية في عمود كل فرع (الفارغ = 0).',
  '3) املئي ورقة «الصور»: سطر لكل صورة، واجمعي ملفات الصور كلها في ملف ZIP واحد.',
  '4) «جدول القياسات» اختياري: سطر لكل مقاس من مقاسات المنتج.',
  '5) ارفعي ملف XLSX وملف ZIP معاً للفحص. الفحص لا ينشئ شيئاً؛ يعرض ما هو جاهز وما فيه أخطاء، ثم تختارين ما يُنشأ كمسودات مكتملة بالصور.',
  '■ الألوان',
  'اسم اللون حر («موكا»، «بيج رملي») وعائلة اللون من القائمة للفلترة. يمكن أن يكون للونين من المنتج نفسه العائلة نفسها. لكل لون مقاساته الخاصة.',
  'كرّري اسم اللون وعائلته ولونه في كل سطر من أسطره بالشكل نفسه. «ترتيب اللون» رقم؛ اللون الأول هو الرئيسي.',
  '■ الصور',
  'لكل لون صورة «رئيسية» واحدة بالضبط، ويمكن إضافة صور «إضافية» له (حتى 10 صور للون مع الرئيسية). اكتبي اسم اللون كما هو في «الألوان والمقاسات».',
  'الصورة «المشتركة» تظهر مع كل الألوان: اتركي خانة اللون فارغة (حتى 6 صور مشتركة). «الترتيب» رقم يحدد ترتيب الصور الإضافية والمشتركة.',
  'اكتبي «اسم ملف الصورة» كما هو داخل ملف ZIP. استعملي أسماء بأحرف لاتينية وأرقام، مثل dress1-mocha-1.jpg؛ الأسماء العربية قد تتغير عند الضغط في بعض البرامج.',
  'الصيغ المقبولة: JPG وPNG وWebP، حتى 5 ميغابايت و25 ميغابكسل للصورة. صور iPhone بصيغة HEIC وملفات SVG وGIF غير مقبولة: حوّليها إلى JPG أو PNG أو WebP قبل الضغط.',
  'ملف ZIP: حتى 150 ميغابايت و1000 صورة. الملف غير المذكور في «الصور» لا يُحفظ ويظهر كتنبيه. لا تُنشر الصور قبل التأكيد، وتُحذف منها بيانات الموقع والكاميرا.',
  '■ مكوّنات القماش وبلد المنشأ (اختياري)',
  'لكل جزء من القطعة خانة: «تركيب الخامة الخارجية»، «تركيب البطانة»، «تركيب الحشوة»، «تركيب الأطراف والتطريز». اكتبي النسبة ثم الليف، وافصلي بفاصلة، مثل: 95% قطن، 5% إيلاستين',
  'مجموع كل جزء 100% بالضبط، والنسب أعداد صحيحة، ولا يتكرر الليف في الجزء نفسه (حتى 6 ألياف). أسماء الألياف في ورقة «القوائم»؛ لليف غير موجود اكتبي: 5% أخرى: اسم الليف',
  'اتركي الخانة فارغة إن لم تعرفي التركيب. «بلد المنشأ» من القائمة، مثل: تركيا. هذه المعلومات لا تمنع الاستيراد ولا النشر إن كانت فارغة، و«الخامة» تبقى مواصفة مستقلة.',
  '■ الباركود (عمود «الباركود»)',
  'باركود واحد للمنتج كله، لكل ألوانه ومقاساته - ليس لكل لون أو مقاس. إن كان على المنتج باركود من المصنع أو ملصق موجود، انسخيه كما هو في هذا العمود (EAN-13 أو UPC أو EAN-8 أو Code 128).',
  'اكتبيه كنص، لا كرقم، حتى لا يحذف Excel الصفر في أوله. الباركود غير الصحيح، أو المكرر في الملف، أو المستخدم لمنتج آخر في متجرك، يرفض صف المنتج مع السبب.',
  'إن تركتِ الخانة فارغة لا يُنشأ باركود تلقائياً؛ فقد يكون للمنتج باركود فعلاً ولم يُكتب. تُنشأ المسودة بلا باركود، وقبل النشر تختارين: إدخاله أو مسحه لكل منتج، أو إنشاء باركود من النظام.',
  'الباركود مطلوب لنشر المنتج.',
  '■ ما لا يدخل من الملف',
  'لا يوجد في الملف رمز SKU؛ يولّده النظام. لا روابط صور ولا صور ملصقة داخل Excel - الصور من ملف ZIP فقط.',
  '■ العلامة التجارية',
  'اختاري علامة موجودة من القائمة أو «بدون علامة تجارية». العلامة الجديدة تُطلب من المعالج.',
  '■ النتيجة',
  'المنتج إما جاهز (مكتمل بصوره ويمكن نشره كما هو) أو مرفوض مع السبب. المنتجات المختارة تُنشأ كلها معاً كمسودات غير منشورة مكتملة بالصور (أو لا يُنشأ أي منها)، وتظهر في «مسوداتي» بعلامة «مستورد». لا يُنشر أي منتج تلقائياً.',
  '■ مثال',
  'المنتجات: 1 | فستان سهرة مخملي | Velvet evening dress | نساء | فساتين | بدون علامة تجارية | ... | 250 | ... | حروف',
  'الألوان والمقاسات: 1 | موكا | Mocha | بني | | 1 | S | الكمية: فرع رام الله = 3',
  'الألوان والمقاسات: 1 | بيج رملي | Sand beige | بيج | | 2 | M | الكمية: فرع نابلس = 4',
  'الصور: 1 | موكا | dress1-mocha-1.jpg | رئيسية |',
  'الصور: 1 | موكا | dress1-mocha-2.jpg | إضافية | 1',
  'الصور: 1 | بيج رملي | dress1-sand-1.jpg | رئيسية |',
  'الصور: 1 | (فارغ) | dress1-detail.jpg | مشتركة | 1',
  'المنتجات (التركيب): تركيب الخامة الخارجية = 95% قطن، 5% إيلاستين | تركيب البطانة = 100% بوليستر | بلد المنشأ = تركيا',
];
const INSTRUCTIONS_EN = [
  'Import products from a file - instructions',
  '■ Steps',
  '1) Fill in «Products»: one row per product. «Product no. in this file» is any number you choose (1, 2, 3...) that links the product to its colours, sizes and images in this file only.',
  '2) Fill in «Colours and sizes»: one row per colour x size, with the same product no. Write the quantity in each branch column (empty = 0).',
  '3) Fill in «Images»: one row per image, and put all the image files in one ZIP file.',
  '4) «Size table» is optional: one row per size of the product.',
  '5) Upload the XLSX file and the ZIP file together to check them. The check creates nothing; it shows what is ready and what has errors, then you choose what becomes complete drafts with their images.',
  '■ Colours',
  'The colour name is free («Mocha», «Sand beige»); the colour family comes from the list, for filters. Two colours of a product may share a family. Each colour has its own sizes.',
  'Repeat the colour name, family and swatch the same way on each of its rows. «Colour order» is a number; the first colour is the main one.',
  '■ Images',
  'Each colour has exactly one «Main» image, and may have «Extra» images (up to 10 per colour with the main one). Write the colour name as in «Colours and sizes».',
  'A «Shared» image shows with every colour: leave the colour empty (up to 6 shared images). «Order» is a number that orders the extra and shared images.',
  'Write «Image file name» as it is inside the ZIP file. Use Latin letters and digits, like dress1-mocha-1.jpg; Arabic names may change when some programs compress them.',
  'Accepted formats: JPG, PNG and WebP, up to 5 MB and 25 megapixels per image. iPhone HEIC photos, SVG and GIF files are not accepted: convert them to JPG, PNG or WebP before zipping.',
  'ZIP file: up to 150 MB and 1000 images. A file not named in «Images» is not kept and is shown as a warning. Images are not published before you confirm, and their location and camera data are removed.',
  '■ Fabric composition and country of origin (optional)',
  'Each part of the garment has a cell: «Shell composition», «Lining composition», «Filling composition», «Trim composition». Write the percent then the fibre, separated by commas, like: 95% Cotton, 5% Elastane',
  'Each part totals exactly 100%, percents are whole numbers, and a fibre appears once per part (up to 6 fibres). The fibres are listed in «Lists»; for a fibre not listed write: 5% Other: fibre name',
  'Leave the cell empty when you do not know it. «Country of origin» comes from the list, like: Turkey. Empty, they never stop the import or publishing; «Material» stays its own spec.',
  '■ Barcode («Barcode» column)',
  'ONE barcode for the whole product, all its colours and sizes - not one per colour or size. If the item already carries a maker or store barcode, copy it as it is into this column (EAN-13, UPC, EAN-8 or Code 128).',
  'Type it as text, not as a number, so Excel keeps a leading zero. A wrong barcode, one repeated in the file, or one another product of your store uses rejects the product row with the reason.',
  'An empty cell does NOT create a barcode: the item may have one that was not written. The draft is created without it, and before publishing you choose: type or scan one per product, or generate them.',
  'A product needs its barcode to be published.',
  '■ Not in the file',
  'There is no SKU in the file; the system makes it. No image links and no images pasted into Excel - images come from the ZIP file only.',
  '■ Brand',
  'Choose an existing brand from the list, or «No brand». A new brand is requested from the wizard.',
  '■ The result',
  'A product is either ready (complete with its images and publishable as it is) or rejected with the reason. The chosen products are all created together as complete unpublished drafts with their images (or none is), and show in «My drafts» marked «Imported». Nothing is published automatically.',
  '■ Example',
  'Images: 1 | Mocha | dress1-mocha-1.jpg | Main |',
  'Images: 1 | Mocha | dress1-mocha-2.jpg | Extra | 1',
  'Images: 1 | (empty) | dress1-detail.jpg | Shared | 1',
  'Products (composition): Shell composition = 95% Cotton, 5% Elastane | Lining composition = 100% Polyester | Country of origin = Turkey',
];

/** A cell's value as text (numbers as typed, dates as ISO), or null when empty. */
export function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'object') {
    if ('richText' in v)
      return cellText(v.richText.map((t) => t.text).join(''));
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue);
    if ('text' in v) return cellText(String(v.text));
  }
  return null;
}

export interface SheetRows {
  /** The header of each column, as written. */
  headers: string[];
  rows: { row: number; cells: (string | null)[] }[];
}

/** The workbook's sheets by name (Arabic or English), each as its header and non-empty rows. */
export async function readWorkbook(
  buffer: Buffer,
): Promise<Map<string, SheetRows>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const out = new Map<string, SheetRows>();
  wb.eachSheet((ws) => {
    const headerRow = ws.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
      headers[col - 1] = (cellText(cell.value) ?? '').replace(/\s*\*$/, '');
    });
    const rows: SheetRows['rows'] = [];
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const cells: (string | null)[] = [];
      let any = false;
      for (let c = 1; c <= headers.length; c += 1) {
        const t = cellText(row.getCell(c).value);
        cells.push(t);
        if (t !== null) any = true;
      }
      if (any) rows.push({ row: r, cells });
    }
    out.set(plain(ws.name), { headers, rows });
  });
  return out;
}

/** The sheet named by these words (Arabic or English), if any. */
export function sheetOf(
  sheets: Map<string, SheetRows>,
  w: Words,
): SheetRows | null {
  return sheets.get(plain(w.ar)) ?? sheets.get(plain(w.en)) ?? null;
}

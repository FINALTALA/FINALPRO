"use client";

import { useEffect, useRef, useState } from "react";
import { StarIcon } from "./Icons";
import { apiFetch, newIdempotencyKey, REVIEW_IMAGE_ACCEPT, uploadReviewImage } from "@/lib/api";
import {
  fitLabel,
  MAX_REVIEW_IMAGES,
  MAX_REVIEW_TAGS,
  REVIEW_BODY_MAX,
  ReviewAuthorDisplay,
  ReviewDto,
  ReviewFit,
  ReviewTag,
  purchasedLineIn,
  reviewErrorMessageIn,
  tagLabel,
} from "@/lib/reviews";
import { registerTranslations, translate } from "@/lib/i18n";
import { useLang } from "@/lib/useLang";
import { apiErrorMessage } from "@/lib/apiErrors";
import { useTaxonomy } from "@/lib/taxonomy";
import { colorName, sizeName } from "@/lib/localized";
import { fmt } from "@/lib/shopText";

// TB-25: the review panel's own words (Arabic unchanged).
registerTranslations({
  ar: {
    "rvc.word.1": "سيئ", "rvc.word.2": "مقبول", "rvc.word.3": "جيد", "rvc.word.4": "جيد جداً", "rvc.word.5": "ممتاز",
    "rvc.err.format": "الصيغ المسموحة: JPG أو PNG أو WebP.",
    "rvc.err.size": "حجم الصورة أكبر من 5 ميغابايت.",
    "rvc.err.max": "يمكن إرفاق {n} صور كحد أقصى.",
    "rvc.err.stars": "اختاري عدد النجوم أولاً.",
    "rvc.err.body": "اكتبي رأيك في سطر على الأقل.",
    "rvc.err.consent": "وافقي على نشر الصور أولاً.",
    "rvc.err.uploads": "حُفظ التقييم، لكن تعذّر رفع: {files}",
    "rvc.edit_title": "تعديل تقييمك",
    "rvc.review.PRODUCT": "قيّمي المنتج",
    "rvc.review.STORE": "قيّمي المتجر",
    "rvc.close": "إغلاق",
    "rvc.loading": "جارٍ التحميل…",
    "rvc.locked_window": "انتهت مهلة تعديل النص والتقييم (30 يوماً). ما زال بإمكانك تغيير طريقة ظهور اسمك أو حذف صورك أو التقييم.",
    "rvc.locked_report": "على هذا التقييم بلاغ قيد المراجعة، فلا يمكن تعديل نصه الآن.",
    "rvc.editable_until": "يمكن التعديل حتى {date}. يظهر التقييم بعد التعديل بعلامة «معدّل».",
    "rvc.your_rating": "تقييمك",
    "rvc.stars": "عدد النجوم",
    "rvc.of5": "{n} من 5",
    "rvc.your_view": "رأيك",
    "rvc.placeholder": "ما الذي أعجبك أو لم يعجبك؟ كيف كانت الخامة والمقاس؟",
    "rvc.fit": "ملاءمة المقاس",
    "rvc.optional": "(اختياري)",
    "rvc.impression": "انطباعك",
    "rvc.up_to": "(حتى {n})",
    "rvc.photos": "صور",
    "rvc.photos_hint": "(حتى {n} · JPG أو PNG أو WebP · 5 ميغابايت)",
    "rvc.your_photo": "صورة من تقييمك",
    "rvc.delete_photo": "حذف الصورة",
    "rvc.remove_photo": "إزالة الصورة",
    "rvc.photo_alt_placeholder": "وصف قصير للصورة",
    "rvc.photo_alt": "وصف الصورة",
    "rvc.add_photo": "إضافة صورة",
    "rvc.consent": "أوافق على نشر هذه الصور علناً مع تقييمي، وأؤكد أنها لا تُظهر بيانات شخصية لي أو لغيري.",
    "rvc.metadata": "نزيل من الصور أي بيانات مخفية (مثل الموقع) قبل نشرها.",
    "rvc.name_display": "كيف يظهر اسمك",
    "rvc.anonymous": "عميل موثّق",
    "rvc.first_initial": "الاسم الأول والحرف الأول",
    "rvc.privacy": "لا يظهر أبداً اسمك الكامل أو رقمك أو عنوانك.",
    "rvc.confirm_delete": "حذف التقييم نهائياً؟ لن تتمكني من كتابة تقييم بديل لهذا الطلب.",
    "rvc.yes_delete": "نعم، احذفي",
    "rvc.back": "تراجع",
    "rvc.delete": "حذف التقييم",
    "rvc.cancel": "إلغاء",
    "rvc.saving": "جارٍ الحفظ…",
    "rvc.save_edit": "حفظ التعديل",
    "rvc.publish": "نشر التقييم",
  },
  en: {
    "rvc.word.1": "Poor", "rvc.word.2": "Fair", "rvc.word.3": "Good", "rvc.word.4": "Very good", "rvc.word.5": "Excellent",
    "rvc.err.format": "Allowed formats: JPG, PNG or WebP.",
    "rvc.err.size": "The image is larger than 5 MB.",
    "rvc.err.max": "You can attach at most {n} images.",
    "rvc.err.stars": "Choose a star rating first.",
    "rvc.err.body": "Write at least one line about it.",
    "rvc.err.consent": "Agree to publishing the images first.",
    "rvc.err.uploads": "The review was saved, but these couldn't be uploaded: {files}",
    "rvc.edit_title": "Edit your review",
    "rvc.review.PRODUCT": "Review the product",
    "rvc.review.STORE": "Review the store",
    "rvc.close": "Close",
    "rvc.loading": "Loading…",
    "rvc.locked_window": "The time to edit the text and rating has ended (30 days). You can still change how your name appears, delete your images or delete the review.",
    "rvc.locked_report": "This review has a report under review, so its text can't be edited right now.",
    "rvc.editable_until": "You can edit it until {date}. After an edit, the review shows an «edited» mark.",
    "rvc.your_rating": "Your rating",
    "rvc.stars": "Star rating",
    "rvc.of5": "{n} out of 5",
    "rvc.your_view": "Your review",
    "rvc.placeholder": "What did you like or not like? How were the material and the size?",
    "rvc.fit": "Size fit",
    "rvc.optional": "(optional)",
    "rvc.impression": "Your impression",
    "rvc.up_to": "(up to {n})",
    "rvc.photos": "Photos",
    "rvc.photos_hint": "(up to {n} · JPG, PNG or WebP · 5 MB)",
    "rvc.your_photo": "An image from your review",
    "rvc.delete_photo": "Delete image",
    "rvc.remove_photo": "Remove image",
    "rvc.photo_alt_placeholder": "Short description of the image",
    "rvc.photo_alt": "Image description",
    "rvc.add_photo": "Add image",
    "rvc.consent": "I agree to publish these images publicly with my review, and confirm they don't show personal details of mine or anyone else's.",
    "rvc.metadata": "We remove any hidden data (such as location) from images before publishing them.",
    "rvc.name_display": "How your name appears",
    "rvc.anonymous": "Verified customer",
    "rvc.first_initial": "First name and initial",
    "rvc.privacy": "Your full name, number or address are never shown.",
    "rvc.confirm_delete": "Delete the review for good? You won't be able to write a replacement for this order.",
    "rvc.yes_delete": "Yes, delete",
    "rvc.back": "Go back",
    "rvc.delete": "Delete review",
    "rvc.cancel": "Cancel",
    "rvc.saving": "Saving…",
    "rvc.save_edit": "Save changes",
    "rvc.publish": "Publish review",
  },
});

/** A message kept until render: a key (with values), an API failure, or text. */
type RvcMsg = { key: string; vars?: Record<string, string | number> } | { api: unknown } | { text: string };

export type ComposerTarget =
  | {
      mode: "create";
      itemId: string;
      target: "PRODUCT" | "STORE";
      /** What was bought, for the panel's heading. */
      title: string;
      purchased: string | null;
    }
  | { mode: "edit"; reviewId: string };

interface PendingImage {
  key: string;
  file: File;
  preview: string;
  alt: string;
}

// TB-25: the rating words are rvc.word.<1-5>.
const REVIEW_TAGS: ReviewTag[] = ["GOOD_QUALITY", "EXCELLENT_MATERIAL", "MATCHES_PHOTOS", "COMFORTABLE", "GOOD_VALUE", "BELOW_EXPECTATIONS", "DIFFERS_FROM_PHOTOS"];

/**
 * PD-3: write or edit a review in a modal panel over the page (the
 * project's approved dark, blurred overlay). Everything it shows comes
 * from the API - the purchased colour/size are the order's own snapshot,
 * never typed here. Content edits are possible within 30 days; the
 * display name and image removal at any time; deleting is permanent.
 */
export default function ReviewComposer({
  target,
  onClose,
  onSaved,
}: {
  target: ComposerTarget;
  onClose: () => void;
  /** The saved review, or null once it was deleted. */
  onSaved: (review: ReviewDto | null) => void;
}) {
  const lang = useLang();
  const t = (key: string) => translate(lang, key);
  const taxonomy = useTaxonomy().data;
  const errText = (err: unknown) => reviewErrorMessageIn(err, lang, (e) => apiErrorMessage(e, lang));
  const msgText = (m: RvcMsg) => ("text" in m ? m.text : "api" in m ? errText(m.api) : m.vars ? fmt(t(m.key), m.vars) : t(m.key));
  const [existing, setExisting] = useState<ReviewDto | null>(null);
  const [loadError, setLoadError] = useState<RvcMsg | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [body, setBody] = useState("");
  const [fit, setFit] = useState<ReviewFit | null>(null);
  const [tags, setTags] = useState<ReviewTag[]>([]);
  const [display, setDisplay] = useState<ReviewAuthorDisplay>("ANONYMOUS");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RvcMsg | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const editing = target.mode === "edit";
  const isProduct = editing ? existing?.target_type === "PRODUCT" : target.target === "PRODUCT";
  // Content is locked once the window closed or a report is open; the
  // display name, image removal and deletion stay available.
  const contentLocked = editing && !!existing && !existing.viewer?.can_edit;
  const imageCount = (existing?.media.length ?? 0) + pending.length;

  // Load the author's own review when editing.
  useEffect(() => {
    if (target.mode !== "edit") return;
    let cancelled = false;
    apiFetch<ReviewDto>(`/reviews/${target.reviewId}`)
      .then((r) => {
        if (cancelled) return;
        setExisting(r);
        setRating(r.rating);
        setBody(r.body);
        setFit(r.fit);
        setTags(r.tags);
        setDisplay(r.author_display ?? "ANONYMOUS");
      })
      .catch((err) => !cancelled && setLoadError({ api: err }));
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Modal behaviour: focus inside, Escape closes, Tab stays inside, the
  // page behind doesn't scroll; focus returns to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.querySelector<HTMLElement>("button, textarea, input")?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if (e.key === "Tab" && panel) {
        const focusable = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), textarea, input:not(:disabled), a[href]")];
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
  }, [onClose]);

  // Previews are revoked when removed and when the panel closes.
  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.preview)), []);
  function dropPending(key: string) {
    setPending((all) => {
      all.filter((x) => x.key === key).forEach((x) => URL.revokeObjectURL(x.preview));
      return all.filter((x) => x.key !== key);
    });
  }

  function toggleTag(tag: ReviewTag) {
    setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : t.length >= MAX_REVIEW_TAGS ? t : [...t, tag]));
  }

  function addFiles(files: FileList | null) {
    if (!files) return;
    const room = MAX_REVIEW_IMAGES - imageCount;
    const accepted = REVIEW_IMAGE_ACCEPT.split(",");
    const next: PendingImage[] = [];
    for (const file of [...files].slice(0, Math.max(0, room))) {
      if (!accepted.includes(file.type)) {
        setError({ key: "rvc.err.format" });
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError({ key: "rvc.err.size" });
        continue;
      }
      next.push({ key: `${file.name}-${file.size}-${Math.random()}`, file, preview: URL.createObjectURL(file), alt: "" });
    }
    if (files.length > room) setError({ key: "rvc.err.max", vars: { n: MAX_REVIEW_IMAGES } });
    setPending((p) => [...p, ...next]);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function removeExistingImage(mediaId: string) {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/reviews/${existing.id}/media/${mediaId}`, {
        method: "DELETE",
        idempotencyKey: newIdempotencyKey("review-image-delete"),
      });
      const updated = { ...existing, media: existing.media.filter((m) => m.id !== mediaId) };
      setExisting(updated);
      onSaved(updated);
    } catch (err) {
      setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!contentLocked && rating === 0) {
      setError({ key: "rvc.err.stars" });
      return;
    }
    if (!contentLocked && body.trim().length === 0) {
      setError({ key: "rvc.err.body" });
      return;
    }
    if (pending.length > 0 && !consent) {
      setError({ key: "rvc.err.consent" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let saved: ReviewDto;
      if (target.mode === "create") {
        saved = await apiFetch<ReviewDto>("/reviews", {
          method: "POST",
          idempotencyKey: newIdempotencyKey("review"),
          body: {
            source_branch_order_item_id: target.itemId,
            target_type: target.target,
            rating,
            body: body.trim(),
            author_display: display,
            ...(isProduct ? { tags, ...(fit ? { fit_feedback: fit } : {}) } : {}),
          },
        });
      } else {
        saved = await apiFetch<ReviewDto>(`/reviews/${target.reviewId}`, {
          method: "PATCH",
          idempotencyKey: newIdempotencyKey("review-edit"),
          body: contentLocked
            ? { author_display: display }
            : {
                rating,
                body: body.trim(),
                author_display: display,
                ...(isProduct ? { tags, fit_feedback: fit } : {}),
              },
        });
      }
      // Images go up after the review exists; one failure doesn't lose
      // the review - it is reported and the rest still upload.
      const failed: string[] = [];
      const uploaded = [];
      for (const img of pending) {
        try {
          uploaded.push(await uploadReviewImage(saved.id, img.file, img.alt));
        } catch (err) {
          failed.push(`${img.file.name}: ${errText(err)}`);
        }
      }
      const result: ReviewDto = {
        ...saved,
        media: [
          ...saved.media,
          ...uploaded,
        ],
      };
      onSaved(result);
      if (failed.length) {
        pending.forEach((p) => URL.revokeObjectURL(p.preview));
        setPending([]);
        setExisting(result);
        setError({ key: "rvc.err.uploads", vars: { files: failed.join(" · ") } });
        return;
      }
      onClose();
    } catch (err) {
      setError({ api: err });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/reviews/${existing.id}`, {
        method: "DELETE",
        idempotencyKey: newIdempotencyKey("review-delete"),
      });
      onSaved(null);
      onClose();
    } catch (err) {
      setError({ api: err });
      setBusy(false);
    }
  }

  const heading = editing ? t("rvc.edit_title") : t(`rvc.review.${target.target}`);
  const subject = editing ? existing?.purchased?.title ?? null : target.title;
  const purchased = editing
    ? purchasedLineIn(existing?.purchased ?? null, lang, (code) => colorName(taxonomy, code, lang), (code, label) => sizeName(code, label, lang))
    : target.purchased;
  const shownRating = hover || rating;

  return (
    <div className="rv-overlay" role="presentation" onMouseDown={() => !busy && onClose()}>
      <section
        ref={panelRef}
        className="rv-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rv-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rv-dialog-head">
          <div>
            <h2 id="rv-dialog-title">{heading}</h2>
            {subject && <p className="rv-dialog-subject">{subject}</p>}
            {purchased && <p className="rv-dialog-purchased">{purchased}</p>}
          </div>
          <button type="button" className="rv-close" onClick={onClose} aria-label={t("rvc.close")} disabled={busy}>×</button>
        </header>

        {loadError ? (
          <p className="rv-error" role="alert">{msgText(loadError)}</p>
        ) : editing && !existing ? (
          <div className="rv-loading" aria-busy="true">{t("rvc.loading")}</div>
        ) : (
          <>
            {contentLocked && (
              <p className="rv-note" role="status">
                {existing?.editable_until && new Date(existing.editable_until) <= new Date()
                  ? t("rvc.locked_window")
                  : t("rvc.locked_report")}
              </p>
            )}
            {editing && existing?.editable_until && !contentLocked && (
              <p className="rv-note">{fmt(t("rvc.editable_until"), { date: new Date(existing.editable_until).toLocaleDateString(lang === "en" ? "en-GB" : "ar-EG", { day: "numeric", month: "long" }) })}</p>
            )}

            <fieldset className="rv-field" disabled={contentLocked || busy}>
              <legend>{t("rvc.your_rating")}</legend>
              <div className="rv-stars-input" role="radiogroup" aria-label={t("rvc.stars")} onMouseLeave={() => setHover(0)}>
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={rating === n}
                    aria-label={fmt(t("rvc.of5"), { n })}
                    className={shownRating >= n ? "on" : ""}
                    onMouseEnter={() => setHover(n)}
                    onClick={() => setRating(n)}
                  >
                    <StarIcon />
                  </button>
                ))}
                <span className="rv-stars-word" aria-live="polite">{shownRating ? t(`rvc.word.${shownRating}`) : ""}</span>
              </div>
            </fieldset>

            <label className="rv-field">
              <span className="rv-label">{t("rvc.your_view")}</span>
              <textarea
                value={body}
                maxLength={REVIEW_BODY_MAX}
                rows={4}
                disabled={contentLocked || busy}
                placeholder={t("rvc.placeholder")}
                onChange={(e) => setBody(e.target.value)}
              />
              <span className="rv-count" dir="ltr">{body.length} / {REVIEW_BODY_MAX}</span>
            </label>

            {isProduct && (
              <>
                <fieldset className="rv-field" disabled={contentLocked || busy}>
                  <legend>{t("rvc.fit")} <small>{t("rvc.optional")}</small></legend>
                  <div className="rv-chips">
                    {(["SMALL", "TRUE_TO_SIZE", "LARGE", "NOT_APPLICABLE"] as ReviewFit[]).map((f) => (
                      <button key={f} type="button" aria-pressed={fit === f} className={fit === f ? "is-on" : ""} onClick={() => setFit(fit === f ? null : f)}>
                        {fitLabel(lang, f)}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="rv-field" disabled={contentLocked || busy}>
                  <legend>{t("rvc.impression")} <small>{fmt(t("rvc.up_to"), { n: MAX_REVIEW_TAGS })}</small></legend>
                  <div className="rv-chips">
                    {REVIEW_TAGS.map((tg) => (
                      <button
                        key={tg}
                        type="button"
                        aria-pressed={tags.includes(tg)}
                        className={tags.includes(tg) ? "is-on" : ""}
                        disabled={!tags.includes(tg) && tags.length >= MAX_REVIEW_TAGS}
                        onClick={() => toggleTag(tg)}
                      >
                        {tagLabel(lang, tg)}
                      </button>
                    ))}
                  </div>
                </fieldset>

                <div className="rv-field">
                  <span className="rv-label">{t("rvc.photos")} <small>{fmt(t("rvc.photos_hint"), { n: MAX_REVIEW_IMAGES })}</small></span>
                  <div className="rv-images">
                    {existing?.media.map((m) => (
                      <figure key={m.id} className="rv-thumb">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={m.url} alt={m.alt_text ?? t("rvc.your_photo")} />
                        <button type="button" onClick={() => removeExistingImage(m.id)} disabled={busy} aria-label={t("rvc.delete_photo")}>×</button>
                      </figure>
                    ))}
                    {pending.map((p) => (
                      <figure key={p.key} className="rv-thumb is-new">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.preview} alt="" />
                        <button type="button" onClick={() => dropPending(p.key)} disabled={busy} aria-label={t("rvc.remove_photo")}>×</button>
                        <input
                          type="text"
                          maxLength={200}
                          placeholder={t("rvc.photo_alt_placeholder")}
                          aria-label={t("rvc.photo_alt")}
                          value={p.alt}
                          onChange={(e) => setPending((all) => all.map((x) => (x.key === p.key ? { ...x, alt: e.target.value } : x)))}
                        />
                      </figure>
                    ))}
                    {imageCount < MAX_REVIEW_IMAGES && !contentLocked && (
                      <label className="rv-add-image">
                        <input ref={fileRef} type="file" accept={REVIEW_IMAGE_ACCEPT} multiple onChange={(e) => addFiles(e.target.files)} disabled={busy} />
                        <span aria-hidden="true">+</span>
                        <small>{t("rvc.add_photo")}</small>
                      </label>
                    )}
                  </div>
                  {pending.length > 0 && (
                    <label className="rv-consent">
                      <input
                        type="checkbox"
                        checked={consent}
                        onChange={(e) => {
                          setConsent(e.target.checked);
                          setError(null);
                        }}
                      />
                      <span>{t("rvc.consent")}</span>
                    </label>
                  )}
                  <p className="rv-hint">{t("rvc.metadata")}</p>
                </div>
              </>
            )}

            <fieldset className="rv-field" disabled={busy}>
              <legend>{t("rvc.name_display")}</legend>
              <div className="rv-chips">
                <button type="button" aria-pressed={display === "ANONYMOUS"} className={display === "ANONYMOUS" ? "is-on" : ""} onClick={() => setDisplay("ANONYMOUS")}>{t("rvc.anonymous")}</button>
                <button type="button" aria-pressed={display === "FIRST_NAME_INITIAL"} className={display === "FIRST_NAME_INITIAL" ? "is-on" : ""} onClick={() => setDisplay("FIRST_NAME_INITIAL")}>{t("rvc.first_initial")}</button>
              </div>
              <p className="rv-hint">{t("rvc.privacy")}</p>
            </fieldset>

            {error && <p className="rv-error" role="alert">{msgText(error)}</p>}

            <footer className="rv-actions">
              {editing && existing && (
                confirmDelete ? (
                  <span className="rv-confirm">
                    <span>{t("rvc.confirm_delete")}</span>
                    <button type="button" className="rv-danger" onClick={remove} disabled={busy}>{t("rvc.yes_delete")}</button>
                    <button type="button" className="rv-ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>{t("rvc.back")}</button>
                  </span>
                ) : (
                  <button type="button" className="rv-ghost rv-delete" onClick={() => setConfirmDelete(true)} disabled={busy}>{t("rvc.delete")}</button>
                )
              )}
              <span className="rv-actions-end">
                <button type="button" className="rv-ghost" onClick={onClose} disabled={busy}>{t("rvc.cancel")}</button>
                <button type="button" className="rv-primary" onClick={save} disabled={busy}>
                  {busy ? t("rvc.saving") : editing ? t("rvc.save_edit") : t("rvc.publish")}
                </button>
              </span>
            </footer>
          </>
        )}
      </section>
    </div>
  );
}


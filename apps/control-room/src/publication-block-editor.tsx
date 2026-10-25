import { useState } from "react";

import type { PublicationWorkspaceBlock } from "@blogmaatic/operator-client";

export interface PublicationBlockImageAsset {
  readonly id: string;
  readonly label: string;
  readonly source: string;
}

interface PublicationBlockEditorProps {
  readonly blocks: readonly PublicationWorkspaceBlock[];
  readonly imageAssets: readonly PublicationBlockImageAsset[];
  readonly disabled?: boolean;
  readonly onChange: (blocks: readonly PublicationWorkspaceBlock[]) => void;
}

type EditableBlockKind = "heading" | "paragraph" | "quote" | "code" | "callout" | "embed" | "image";

const addableKinds: readonly { readonly value: EditableBlockKind; readonly label: string }[] = [
  { value: "paragraph", label: "Paragraph" },
  { value: "heading", label: "Heading" },
  { value: "quote", label: "Quote" },
  { value: "code", label: "Code" },
  { value: "callout", label: "Callout" },
  { value: "embed", label: "Embed / HTML" },
  { value: "image", label: "Image" },
];

function blockId(): string {
  return `block_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function newBlock(
  kind: EditableBlockKind,
  imageAssets: readonly PublicationBlockImageAsset[],
): PublicationWorkspaceBlock {
  switch (kind) {
    case "heading":
      return { id: blockId(), kind, data: { level: 2, text: "" } };
    case "paragraph":
      return { id: blockId(), kind, data: { text: "" } };
    case "quote":
      return { id: blockId(), kind, data: { text: "", attribution: "" } };
    case "code":
      return { id: blockId(), kind, data: { code: "", language: "" } };
    case "callout":
      return { id: blockId(), kind, data: { label: "Note", text: "" } };
    case "embed":
      return { id: blockId(), kind, data: { html: "", url: "" } };
    case "image":
      return {
        id: blockId(),
        kind,
        data: {
          assetId: imageAssets[0]?.id ?? "",
          alt: "",
          caption: "",
        },
      };
  }
}

function textValue(block: PublicationWorkspaceBlock, key: string): string {
  const value = block.data[key];
  return typeof value === "string" ? value : "";
}

function numberValue(block: PublicationWorkspaceBlock, key: string, fallback: number): number {
  const value = block.data[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function BlockFields({
  block,
  imageAssets,
  disabled,
  onChange,
}: {
  readonly block: PublicationWorkspaceBlock;
  readonly imageAssets: readonly PublicationBlockImageAsset[];
  readonly disabled: boolean;
  readonly onChange: (block: PublicationWorkspaceBlock) => void;
}) {
  const update = (key: string, value: string | number) => {
    onChange({ ...block, data: { ...block.data, [key]: value } });
  };

  switch (block.kind) {
    case "heading":
      return (
        <div className="publication-block-fields publication-block-fields--heading">
          <label className="field">
            <span>Level</span>
            <select
              value={Math.min(6, Math.max(1, Math.trunc(numberValue(block, "level", 2))))}
              onChange={(event) => update("level", Number(event.target.value))}
              disabled={disabled}
            >
              {[1, 2, 3, 4, 5, 6].map((level) => <option value={level} key={level}>H{level}</option>)}
            </select>
          </label>
          <label className="field publication-block-fields__grow">
            <span>Heading</span>
            <input value={textValue(block, "text")} onChange={(event) => update("text", event.target.value)} disabled={disabled} />
          </label>
        </div>
      );
    case "paragraph":
      return (
        <label className="field">
          <span>Paragraph</span>
          <textarea rows={5} value={textValue(block, "text")} onChange={(event) => update("text", event.target.value)} disabled={disabled} />
        </label>
      );
    case "quote":
      return (
        <div className="publication-block-fields">
          <label className="field publication-block-fields__full">
            <span>Quote</span>
            <textarea rows={4} value={textValue(block, "text")} onChange={(event) => update("text", event.target.value)} disabled={disabled} />
          </label>
          <label className="field publication-block-fields__full">
            <span>Attribution</span>
            <input value={textValue(block, "attribution")} onChange={(event) => update("attribution", event.target.value)} placeholder="Optional source or speaker" disabled={disabled} />
          </label>
        </div>
      );
    case "code":
      return (
        <div className="publication-block-fields">
          <label className="field publication-block-fields__full">
            <span>Language</span>
            <input value={textValue(block, "language")} onChange={(event) => update("language", event.target.value)} placeholder="javascript, php, css…" disabled={disabled} />
          </label>
          <label className="field publication-block-fields__full">
            <span>Code</span>
            <textarea className="publication-block-code" rows={8} value={textValue(block, "code")} onChange={(event) => update("code", event.target.value)} spellCheck={false} disabled={disabled} />
          </label>
        </div>
      );
    case "callout":
      return (
        <div className="publication-block-fields">
          <label className="field">
            <span>Label</span>
            <input value={textValue(block, "label")} onChange={(event) => update("label", event.target.value)} placeholder="Note" disabled={disabled} />
          </label>
          <label className="field publication-block-fields__grow">
            <span>Callout text</span>
            <textarea rows={4} value={textValue(block, "text")} onChange={(event) => update("text", event.target.value)} disabled={disabled} />
          </label>
        </div>
      );
    case "embed":
      return (
        <div className="publication-block-fields">
          <label className="field publication-block-fields__full">
            <span>Embed URL</span>
            <input type="url" value={textValue(block, "url")} onChange={(event) => update("url", event.target.value)} placeholder="https://…" disabled={disabled} />
          </label>
          <label className="field publication-block-fields__full">
            <span>Raw HTML</span>
            <textarea rows={8} value={textValue(block, "html")} onChange={(event) => update("html", event.target.value)} placeholder="<div>…</div>" disabled={disabled} />
            <small>When HTML is present it takes precedence over the URL. Raw HTML remains deliberate canonical content.</small>
          </label>
        </div>
      );
    case "image": {
      const assetId = textValue(block, "assetId");
      const selected = imageAssets.find((asset) => asset.id === assetId);
      return (
        <div className="publication-block-fields">
          <label className="field publication-block-fields__full">
            <span>Canonical image asset</span>
            <select value={assetId} onChange={(event) => update("assetId", event.target.value)} disabled={disabled || imageAssets.length === 0}>
              <option value="">Select an image</option>
              {imageAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.label}</option>)}
            </select>
            {selected ? <small>{selected.source}</small> : textValue(block, "src") ? <small>Legacy external source: {textValue(block, "src")}</small> : null}
          </label>
          <label className="field">
            <span>Alt text override</span>
            <input value={textValue(block, "alt")} onChange={(event) => update("alt", event.target.value)} disabled={disabled} />
          </label>
          <label className="field publication-block-fields__grow">
            <span>Caption</span>
            <input value={textValue(block, "caption")} onChange={(event) => update("caption", event.target.value)} disabled={disabled} />
          </label>
        </div>
      );
    }
    case "gallery":
    case "table":
      return (
        <div className="publication-block-preserved">
          <strong>{block.kind === "gallery" ? "Gallery" : "Table"} preserved</strong>
          <span>A dedicated visual editor is not available yet. This canonical payload will remain unchanged unless you remove or duplicate the block.</span>
          <pre>{JSON.stringify(block.data, null, 2)}</pre>
        </div>
      );
  }
}

export function PublicationBlockEditor({
  blocks,
  imageAssets,
  disabled = false,
  onChange,
}: PublicationBlockEditorProps) {
  const [kind, setKind] = useState<EditableBlockKind>("paragraph");

  const replace = (index: number, block: PublicationWorkspaceBlock) => {
    onChange(blocks.map((current, currentIndex) => currentIndex === index ? block : current));
  };

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    const [item] = next.splice(index, 1);
    if (!item) return;
    next.splice(target, 0, item);
    onChange(next);
  };

  const duplicate = (index: number) => {
    const source = blocks[index];
    if (!source) return;
    const next = [...blocks];
    next.splice(index + 1, 0, { ...source, id: blockId(), data: { ...source.data } });
    onChange(next);
  };

  const remove = (index: number) => {
    onChange(blocks.filter((_, currentIndex) => currentIndex !== index));
  };

  const add = () => {
    if (kind === "image" && imageAssets.length === 0) return;
    onChange([...blocks, newBlock(kind, imageAssets)]);
  };

  return (
    <section className="publication-block-editor" aria-labelledby="publication-block-editor-title">
      <div className="publication-block-editor__header">
        <span>
          <strong id="publication-block-editor-title">Content blocks</strong>
          <small>{blocks.length} block{blocks.length === 1 ? "" : "s"} · order is canonical</small>
        </span>
        <span className="publication-block-editor__add">
          <label className="field">
            <span>Add block</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as EditableBlockKind)} disabled={disabled}>
              {addableKinds.map((option) => (
                <option value={option.value} key={option.value} disabled={option.value === "image" && imageAssets.length === 0}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button button--quiet" type="button" onClick={add} disabled={disabled || (kind === "image" && imageAssets.length === 0)}>Add</button>
        </span>
      </div>

      <div className="publication-block-editor__list">
        {blocks.map((block, index) => (
          <article className="publication-block" key={block.id}>
            <header className="publication-block__header">
              <span>
                <strong>{index + 1}. {block.kind}</strong>
                <small>{block.id}</small>
              </span>
              <span className="publication-block__actions">
                <button type="button" className="button button--quiet" onClick={() => move(index, -1)} disabled={disabled || index === 0} aria-label={`Move ${block.kind} block up`}>↑</button>
                <button type="button" className="button button--quiet" onClick={() => move(index, 1)} disabled={disabled || index === blocks.length - 1} aria-label={`Move ${block.kind} block down`}>↓</button>
                <button type="button" className="button button--quiet" onClick={() => duplicate(index)} disabled={disabled}>Duplicate</button>
                <button type="button" className="button button--quiet" onClick={() => remove(index)} disabled={disabled}>Remove</button>
              </span>
            </header>
            <BlockFields
              block={block}
              imageAssets={imageAssets}
              disabled={disabled}
              onChange={(next) => replace(index, next)}
            />
          </article>
        ))}
        {blocks.length === 0 ? (
          <div className="publication-block-editor__empty">
            <strong>No content blocks yet.</strong>
            <span>Add a paragraph, heading, quote, code block, callout, embed, or canonical image.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

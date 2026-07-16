import type { Editor } from '@tiptap/react';

interface Props {
  editor: Editor;
}

interface Btn {
  label: string;
  title: string;
  isActive?: () => boolean;
  run: () => void;
}

export default function Toolbar({ editor }: Props) {
  const buttons: Btn[] = [
    {
      label: 'B',
      title: 'Bold',
      isActive: () => editor.isActive('bold'),
      run: () => editor.chain().focus().toggleBold().run(),
    },
    {
      label: 'I',
      title: 'Italic',
      isActive: () => editor.isActive('italic'),
      run: () => editor.chain().focus().toggleItalic().run(),
    },
    {
      label: 'S',
      title: 'Strikethrough',
      isActive: () => editor.isActive('strike'),
      run: () => editor.chain().focus().toggleStrike().run(),
    },
    {
      label: 'H1',
      title: 'Heading 1',
      isActive: () => editor.isActive('heading', { level: 1 }),
      run: () => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: 'H2',
      title: 'Heading 2',
      isActive: () => editor.isActive('heading', { level: 2 }),
      run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: '••',
      title: 'Bullet list',
      isActive: () => editor.isActive('bulletList'),
      run: () => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: '1.',
      title: 'Ordered list',
      isActive: () => editor.isActive('orderedList'),
      run: () => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: '❝',
      title: 'Blockquote',
      isActive: () => editor.isActive('blockquote'),
      run: () => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      label: '</>',
      title: 'Code block',
      isActive: () => editor.isActive('codeBlock'),
      run: () => editor.chain().focus().toggleCodeBlock().run(),
    },
    { label: '↩', title: 'Undo', run: () => editor.chain().focus().undo().run() },
    { label: '↪', title: 'Redo', run: () => editor.chain().focus().redo().run() },
  ];

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {buttons.map((btn) => (
        <button
          key={btn.title}
          type="button"
          title={btn.title}
          className={`toolbar-btn${btn.isActive?.() ? ' active' : ''}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={btn.run}
          disabled={!editor.isEditable}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}

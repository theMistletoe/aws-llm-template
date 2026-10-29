import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Citations } from './Citations';
import { Composer } from './Composer';
import { Markdown, safeUrlTransform } from './Markdown';

describe('Markdown (sanitized AI output)', () => {
  it('never renders raw HTML or script and escapes code blocks', () => {
    const { container } = render(
      <Markdown
        text={'**太字**\n\n<script>alert("xss")</script><img src=x onerror=alert(1)>\n\n```html\n<b>escaped</b>\n```'}
      />,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('<b>escaped</b>')).toBeVisible();
    expect(screen.getByText('太字').tagName).toBe('STRONG');
  });

  it('only links http(s) URLs and opens them safely', () => {
    render(<Markdown text={'[ok](https://example.com) [bad](javascript:alert(1)) [data](data:text/html,x)'} />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', 'https://example.com');
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('bad').closest('a')).toBeNull();
    expect(safeUrlTransform('JaVaScRiPt:alert(1)')).toBe('');
  });

  it('renders markdown images as text', () => {
    render(<Markdown text={'![alt text](https://example.com/x.png)'} />);
    expect(screen.getByText('[画像: alt text]')).toBeVisible();
  });
});

describe('Citations', () => {
  it('links only safe URLs and shows host and published date', () => {
    render(
      <Citations
        citations={[
          { title: 'Good', url: 'https://docs.example.com/a', publishedDate: '2026-10-01' },
          { title: 'Evil', url: 'javascript:alert(1)' },
        ]}
      />,
    );
    expect(screen.getByRole('link', { name: 'Good' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('docs.example.com')).toBeVisible();
    expect(screen.getByText('公開日: 2026-10-01')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Evil' })).toBeNull();
    expect(screen.getByText('Evil')).toBeVisible();
  });

  it('renders nothing without citations', () => {
    const { container } = render(<Citations citations={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Composer', () => {
  function setup(value: string, streaming = false) {
    const onSend = vi.fn();
    const onStop = vi.fn();
    const onChange = vi.fn();
    render(<Composer value={value} onChange={onChange} onSend={onSend} onStop={onStop} streaming={streaming} />);
    return { onSend, onStop, onChange };
  }

  it('disables sending for empty or too long input', () => {
    setup('   ');
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
  });

  it('enforces the 4000 character limit', () => {
    setup('あ'.repeat(4001));
    expect(screen.getByRole('button', { name: '送信' })).toBeDisabled();
    expect(screen.getByText(/4001 \/ 4000/)).toBeVisible();
    expect(screen.getByLabelText('メッセージ')).toHaveAttribute('aria-invalid', 'true');
  });

  it('sends with Enter but not with Shift+Enter or during IME composition', async () => {
    const { onSend } = setup('こんにちは');
    const box = screen.getByLabelText('メッセージ');
    await userEvent.type(box, '{Shift>}{Enter}{/Shift}');
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionStart(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.compositionEnd(box);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('こんにちは');
  });

  it('shows the stop button while streaming', async () => {
    const { onStop, onSend } = setup('x', true);
    await userEvent.click(screen.getByRole('button', { name: '生成を停止' }));
    expect(onStop).toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('メッセージ'), { key: 'Enter' });
    expect(onSend).not.toHaveBeenCalled();
  });
});

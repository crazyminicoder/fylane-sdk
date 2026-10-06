// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FylaneViewer } from '../src/index.js';

/**
 * The viewer, driven as a reader would: pages arrive from the customer's
 * backend as plain short-lived URLs, and the component pages, zooms and
 * recovers — never holding anything that outlives its own expiry.
 */

const SOURCE = {
  filename: 'report.pdf',
  pages: [
    { url: 'https://cdn.test/p1.webp', width: 800, height: 1000 },
    { url: 'https://cdn.test/p2.webp', width: 800, height: 1000 },
    { url: 'https://cdn.test/p3.webp', width: 800, height: 1000 },
  ],
};

afterEach(cleanup);

describe('<FylaneViewer>', () => {
  it('loads through the backend callback and shows the first page', async () => {
    const load = vi.fn().mockResolvedValue(SOURCE);
    render(<FylaneViewer load={load} />);

    expect(screen.getByText(/Loading document/)).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    });
    expect(load).toHaveBeenCalledOnce();
    expect(screen.getByAltText('Page 1').getAttribute('src')).toBe('https://cdn.test/p1.webp');
  });

  it('pages with the buttons and the arrow keys, clamped at the ends', async () => {
    render(<FylaneViewer load={vi.fn().mockResolvedValue(SOURCE)} />);
    await waitFor(() => screen.getByText('Page 1 of 3'));

    fireEvent.click(screen.getByText('›'));
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();

    const region = screen.getByRole('region');
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();

    // Clamped: a further next stays on the last page, and its button disables.
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(screen.getByText('Page 3 of 3')).toBeTruthy();
    expect(screen.getByText<HTMLButtonElement>('›').disabled).toBe(true);

    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(screen.getByText('Page 2 of 3')).toBeTruthy();
    expect(screen.getByAltText('Page 2').getAttribute('src')).toBe('https://cdn.test/p2.webp');
  });

  it('zooms through fixed steps and reports the level', async () => {
    render(<FylaneViewer load={vi.fn().mockResolvedValue(SOURCE)} />);
    await waitFor(() => screen.getByText('100%'));

    fireEvent.click(screen.getByLabelText('Zoom in'));
    expect(screen.getByText('150%')).toBeTruthy();
    expect(screen.getByAltText('Page 1').getAttribute('width')).toBe('1200'); // 800 × 1.5

    fireEvent.click(screen.getByLabelText('Zoom out'));
    fireEvent.click(screen.getByLabelText('Zoom out'));
    expect(screen.getByText('75%')).toBeTruthy();
  });

  it('shows the failure and retries through the same callback', async () => {
    const onError = vi.fn();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('the URL expired'))
      .mockResolvedValue(SOURCE);
    render(<FylaneViewer load={load} onError={onError} />);

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('the URL expired');
    });
    expect(onError).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => screen.getByText('Page 1 of 3'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('treats an empty document as an error, not a blank screen', async () => {
    render(<FylaneViewer load={vi.fn().mockResolvedValue({ pages: [] })} />);
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('no pages');
    });
  });

  it('hands full control to a render function', async () => {
    render(
      <FylaneViewer load={vi.fn().mockResolvedValue(SOURCE)} initialPage={2}>
        {({ state, next }) => (
          <button type="button" onClick={next}>
            custom {state.phase} p{state.page}
          </button>
        )}
      </FylaneViewer>,
    );
    await waitFor(() => screen.getByText('custom ready p2'));
    fireEvent.click(screen.getByText('custom ready p2'));
    expect(screen.getByText('custom ready p3')).toBeTruthy();
  });
});

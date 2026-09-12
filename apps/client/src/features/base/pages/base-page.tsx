import { useParams } from 'react-router-dom';
import { BaseView } from '../components/base-view';
export default function BasePage() { const { pageId } = useParams(); return pageId ? <BaseView pageId={pageId} editable /> : null; }

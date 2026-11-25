"""Business tools only; browser interactions belong to Browser Use itself."""
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field

class Empty(BaseModel):
    model_config = ConfigDict(extra='forbid')

class Question(Empty):
    label: str = Field(min_length=1, max_length=2000)
    help: str = ''
    kind: Literal['text', 'email', 'url', 'tel', 'number', 'textarea', 'radio', 'checkbox', 'select', 'combobox', 'yesno', 'resume', 'cover_letter', 'unsupported']
    required: bool
    options: list[str]
    autocomplete: str = ''

class Questions(Empty):
    fields: list[Question] = Field(min_length=1, max_length=100)
    notices: str = ''

class Receipt(Empty):
    text: str = Field(min_length=10, max_length=3000)

TOOL_MODELS = {
    'get_saved_answers': Empty, 'report_form': Questions,
    'request_missing_answers': Questions, 'solve_captcha': Empty,
    'request_verification': Empty,
    'report_account_gate': Empty,
    'begin_submission': Empty, 'report_submission': Receipt,
}

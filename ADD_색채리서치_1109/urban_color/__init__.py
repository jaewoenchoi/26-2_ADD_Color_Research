"""Frozen urban-color segmentation integration interface."""
from .engine import Segmenter, ContractError, run_request, verify_bundle
__all__ = ['Segmenter', 'ContractError', 'run_request', 'verify_bundle']

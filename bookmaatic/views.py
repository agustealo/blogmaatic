from django.core.paginator import Paginator, EmptyPage, PageNotAnInteger
from django.shortcuts import render, get_object_or_404
from django.shortcuts import redirect
from django.utils import timezone
from .forms import BookForm

# Create your views here.

from .models import Book

# Book listing

def book_list(request):
    books = Book.objects.filter(publication_date__lte=timezone.now()).order_by('publication_date')
    # Pagination count
    paginator = Paginator(books, 2) # Show 25 contacts per page
    
    page = request.GET.get('page')
    try:
        books = paginator.page(page)
    except PageNotAnInteger:
        # If page is not an integer, deliver first page.
        books = paginator.page(1)
    except EmptyPage:
        # If page is out of range (e.g. 9999), deliver last page of results.
        books = paginator.page(paginator.num_pages)
        
    return render(request, 'bookmaatic/list.html', {'books': books})

def book_detail(request, pk):
    book = get_object_or_404(Book, pk=pk)
    return render(request, 'bookmaatic/detail.html', {'book': book})

def book_new(request):
    if request.method == "POST":
        form = BookForm(request.POST)
        if form.is_valid():
            book = form.save(commit=False)
            book.author = request.user
            book.publication_date = timezone.now()
            book.save()
            return redirect('detail', pk=book.pk)
    else:
        form = BookForm()
    return render(request, 'bookmaatic/edit.html', {'form': form})

def book_edit(request, pk):
    book = get_object_or_404(Book, pk=pk)
    if request.method == "POST":
        form = BookForm(request.POST, instance=book)
        if form.is_valid():
            book = form.save(commit=False)
            book.author = request.user
            book.publication_date = timezone.now()
            book.save()
            return redirect('detail', pk=book.pk)
    else:
        form = BookForm(instance=book)
    return render(request, 'bookmaatic/edit.html', {'form': form})